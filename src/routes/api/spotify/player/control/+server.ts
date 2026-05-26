import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError } from '$lib/playback/errors';

type Action = 'pause' | 'resume' | 'next' | 'previous' | 'seek';
interface Body { action: Action; position_ms?: number }

const ENDPOINT: Record<Action, { method: 'PUT' | 'POST'; path: string }> = {
  pause:    { method: 'PUT',  path: 'pause' },
  resume:   { method: 'PUT',  path: 'play' },
  next:     { method: 'POST', path: 'next' },
  previous: { method: 'POST', path: 'previous' },
  seek:     { method: 'PUT',  path: 'seek' },
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json()) as Body;
  const spec = ENDPOINT[body.action];
  if (!spec) throw error(400, 'unknown action');

  let url = `https://api.spotify.com/v1/me/player/${spec.path}`;
  if (body.action === 'seek') {
    if (typeof body.position_ms !== 'number') throw error(400, 'position_ms required');
    url += `?position_ms=${Math.max(0, Math.floor(body.position_ms))}`;
  }

  const { access_token } = await getValidAccessToken(locals.user.id);
  const res = await fetch(url, {
    method: spec.method,
    headers: { authorization: `Bearer ${access_token}` },
  });

  if (res.ok) return new Response(null, { status: 204 });

  let parsed: unknown = {};
  try { parsed = await res.json(); } catch { /* keep {} */ }
  const mapped = mapSpotifyPlayError(res.status, parsed, res.headers.get('retry-after'));
  const clientStatus =
    mapped.error === 'no_active_device' ? 409 :
    mapped.error === 'premium_required' ? 402 :
    mapped.error === 'rate_limited' ? 429 :
    502;
  return json(mapped, { status: clientStatus });
};
