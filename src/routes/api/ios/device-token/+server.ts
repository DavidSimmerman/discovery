import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mintDeviceToken } from '$lib/server/deviceTokens';
import { readSessionCookie } from '$lib/server/session';

// Mints an opaque bearer token for the iOS wrapper. The web layer (running
// inside the WKWebView with the session cookie) calls this once and hands the
// token to native via the JS bridge; native stores it in the Keychain.
//
// Cookie-authed ONLY: a bearer token must not be able to mint further tokens,
// so a leaked device token can't self-replicate.
export const POST: RequestHandler = async ({ locals, cookies, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  if (readSessionCookie(cookies) !== locals.user.id) {
    throw error(403, 'device tokens can only be minted from a cookie session');
  }
  const body = await request.json().catch(() => ({}));
  const label = typeof body?.label === 'string' ? body.label.slice(0, 100) : undefined;
  const token = await mintDeviceToken(locals.user.id, label);
  // userId lets native bind the token to an account and re-mint on switch.
  return json({ token, userId: locals.user.id });
};
