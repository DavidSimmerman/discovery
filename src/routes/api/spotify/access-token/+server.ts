import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { decryptToken, encryptToken, loadKey } from '$lib/server/crypto';
import { refreshAccessToken } from '$lib/server/spotify';

const SAFETY_MS = 60_000; // refresh 1 min before expiry

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const row = await db.select().from(spotifyTokens)
    .where(eq(spotifyTokens.userId, locals.user.id)).limit(1);
  if (!row[0]) throw error(500, 'no spotify token for user');

  const now = Date.now();
  const expiresAt = row[0].expiresAt?.getTime() ?? 0;

  if (row[0].accessToken && expiresAt - now > SAFETY_MS) {
    return json({ access_token: row[0].accessToken, expires_at: expiresAt });
  }

  // Refresh
  const key = loadKey();
  const refreshToken = decryptToken(row[0].refreshTokenEnc, key);
  const fresh = await refreshAccessToken(refreshToken);
  const newExpiresAt = new Date(now + fresh.expires_in * 1000);
  const newEnc = encryptToken(fresh.refresh_token, key);

  await db.update(spotifyTokens)
    .set({
      accessToken: fresh.access_token,
      refreshTokenEnc: newEnc,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(spotifyTokens.userId, locals.user.id));

  return json({ access_token: fresh.access_token, expires_at: newExpiresAt.getTime() });
};
