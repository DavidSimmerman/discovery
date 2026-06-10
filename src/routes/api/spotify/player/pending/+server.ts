// Pending-play control: arm/inspect/cancel the server-side job that fires a
// queued play the moment a Spotify device becomes available (see
// $lib/server/playback/pending-play for why this lives server-side).
//
// POST   { uris, position_ms? } → 202 { status: 'pending' }
// GET    → { status: 'none' | PendingPlayStatus }
// DELETE → 204

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  armPendingPlay,
  cancelPendingPlay,
  getPendingPlay,
} from '$lib/server/playback/pending-play';

// Spotify caps a play `uris` array at 100; mirror that here.
const MAX_URIS = 100;

interface Body {
  uris?: unknown;
  position_ms?: unknown;
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json().catch(() => ({}))) as Body;
  const uris = Array.isArray(body.uris)
    ? body.uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];
  if (uris.length === 0) throw error(400, 'uris (non-empty string array) required');
  if (uris.length > MAX_URIS) throw error(400, `max ${MAX_URIS} uris`);

  armPendingPlay(locals.user.id, {
    uris,
    ...(typeof body.position_ms === 'number' ? { position_ms: body.position_ms } : {}),
  });
  return json({ status: 'pending' }, { status: 202 });
};

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const job = getPendingPlay(locals.user.id);
  return json(
    { status: job?.status ?? 'none' },
    { headers: { 'cache-control': 'no-store' } },
  );
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  cancelPendingPlay(locals.user.id);
  return new Response(null, { status: 204 });
};
