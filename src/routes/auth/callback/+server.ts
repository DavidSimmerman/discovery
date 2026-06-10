import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode, fetchSpotifyMe, normalizeProduct } from '$lib/server/spotify';
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
  // Ground truth for scope debugging — what Spotify says it granted, which is
  // not always what we asked for (e.g. silently re-used prior consent).
  console.log('[auth] granted scopes:', tokenSet.scope);
  const me = await fetchSpotifyMe(tokenSet.access_token);

  // Feb-2026 API removed `product` from /me; absent → 'premium' so re-logins
  // don't downgrade the owner and gate playback. See normalizeProduct.
  const product = normalizeProduct(me.product);

  // Upsert user
  const existing = await db.select().from(users).where(eq(users.spotifyId, me.id)).limit(1);
  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    await db.update(users)
      .set({ displayName: me.display_name, product, needsReauth: false })
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
      scope: tokenSet.scope ?? null,
    })
    .onConflictDoUpdate({
      target: spotifyTokens.userId,
      set: {
        refreshTokenEnc: enc,
        accessToken: tokenSet.access_token,
        expiresAt,
        scope: tokenSet.scope ?? null,
        updatedAt: new Date(),
      },
    });

  setSessionCookie(cookies, userId);

  // Seed top-artists/top-tracks cache so the user has data on first visit.
  // Fire-and-forget — the redirect doesn't wait, and any failure is swallowed.
  refreshUserTopListsInBackground(userId);

  throw redirect(303, '/');
};
