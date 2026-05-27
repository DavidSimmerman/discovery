import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchSpotifyMe } from '$lib/server/spotify';
import { db } from '$lib/server/db';
import { users, spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { encryptToken, loadKey } from '$lib/server/crypto';
import { setSessionCookie } from '$lib/server/session';
import { refreshUserTopListsInBackground } from '$lib/server/top-lists';

export const GET: RequestHandler = async ({ url, cookies }) => {
  const code = url.searchParams.get('code');
  const oauthErr = url.searchParams.get('error');
  if (oauthErr) throw error(400, `Spotify denied authorization: ${oauthErr}`);
  if (!code) throw error(400, 'Missing code');

  const verifier = cookies.get('disccovery_pkce');
  if (!verifier) throw error(400, 'PKCE verifier missing or expired; please try again');
  cookies.delete('disccovery_pkce', { path: '/auth/callback' });

  const tokenSet = await exchangeCode(code, verifier);
  const me = await fetchSpotifyMe(tokenSet.access_token);

  // Normalize product to the known enum values; treat anything else as 'open'.
  const product: 'premium' | 'free' | 'open' =
    me.product === 'premium' || me.product === 'free' ? me.product : 'open';

  // Upsert user
  const existing = await db.select().from(users).where(eq(users.spotifyId, me.id)).limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    await db.update(users)
      .set({ displayName: me.display_name, product })
      .where(eq(users.id, userId));
  } else {
    const inserted = await db.insert(users)
      .values({ spotifyId: me.id, displayName: me.display_name, product })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }

  // Store / overwrite encrypted refresh token + access token
  const key = loadKey();
  const enc = encryptToken(tokenSet.refresh_token, key);
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);

  await db.insert(spotifyTokens)
    .values({
      userId,
      refreshTokenEnc: enc,
      accessToken: tokenSet.access_token,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: spotifyTokens.userId,
      set: {
        refreshTokenEnc: enc,
        accessToken: tokenSet.access_token,
        expiresAt,
        updatedAt: new Date(),
      },
    });

  setSessionCookie(cookies, userId);

  // Seed top-artists/top-tracks cache so the user has data on first visit.
  // Fire-and-forget — the redirect doesn't wait, and any failure is swallowed.
  refreshUserTopListsInBackground(userId);

  throw redirect(303, '/');
};
