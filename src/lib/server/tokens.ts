import { db } from '$lib/server/db';
import { spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decryptToken, encryptToken, loadKey } from '$lib/server/crypto';
import { refreshAccessToken } from '$lib/server/spotify';

const SAFETY_MS = 60_000; // refresh 1 min before expiry

// Per-process single-flight: keeps overlapping refreshes for the same user from
// stampeding Spotify. Fine for a single-instance deploy; would need a shared lock
// (e.g. Postgres advisory lock) to be correct across multiple instances.
type TokenResult = { access_token: string; expires_at: Date };

const inFlight = new Map<string, Promise<TokenResult>>();

export async function getValidAccessToken(userId: string): Promise<TokenResult> {
	const row = await db.select().from(spotifyTokens)
		.where(eq(spotifyTokens.userId, userId)).limit(1);
	if (!row[0]) throw new Error('no spotify token for user');

	const now = Date.now();
	const expiresAt = row[0].expiresAt?.getTime() ?? 0;

	if (row[0].accessToken && row[0].expiresAt && expiresAt - now > SAFETY_MS) {
		return { access_token: row[0].accessToken, expires_at: row[0].expiresAt };
	}

	const existing = inFlight.get(userId);
	if (existing) return existing;

	const key = loadKey();
	const refreshToken = decryptToken(row[0].refreshTokenEnc, key);

	const promise = (async () => {
		const fresh = await refreshAccessToken(refreshToken);
		const newExpiresAt = new Date(Date.now() + fresh.expires_in * 1000);
		const newEnc = encryptToken(fresh.refresh_token, key);

		await db.update(spotifyTokens)
			.set({
				accessToken: fresh.access_token,
				refreshTokenEnc: newEnc,
				expiresAt: newExpiresAt,
				updatedAt: new Date(),
			})
			.where(eq(spotifyTokens.userId, userId));

		return { access_token: fresh.access_token, expires_at: newExpiresAt };
	})().finally(() => {
		inFlight.delete(userId);
	});

	inFlight.set(userId, promise);
	return promise;
}
