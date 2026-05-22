import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { applyLabel, unapplyLabel } from '$lib/server/labels';

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri, name } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }
  if (typeof name !== 'string') {
    throw error(400, 'name must be a string');
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw error(400, 'name must not be empty');
  }
  if (trimmed.length > 50) {
    throw error(400, 'name must be 50 characters or fewer');
  }

  const label = await applyLabel(locals.user.id, spotifyTrackUri, trimmed);

  return json({ ok: true, label });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri, labelId } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }
  if (typeof labelId !== 'string' || !UUID_RE.test(labelId)) {
    throw error(400, 'invalid labelId');
  }

  await unapplyLabel(locals.user.id, spotifyTrackUri, labelId);

  return json({ ok: true });
};
