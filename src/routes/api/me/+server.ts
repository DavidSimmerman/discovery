import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

// Lightweight session probe. The iOS wrapper uses it (via the JS bridge) to
// detect logout/account switches so its Keychain device token never writes to
// the wrong account. 200 with null — not 401 — so callers can poll cheaply.
export const GET: RequestHandler = async ({ locals }) => {
  return json(
    { userId: locals.user?.id ?? null },
    { headers: { 'cache-control': 'no-store' } },
  );
};
