import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError } from '$lib/playback/errors';

interface Body { device_id: string; play?: boolean }

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json()) as Body;
  if (!body.device_id) throw error(400, 'device_id required');

  const { access_token } = await getValidAccessToken(locals.user.id);

  const res = await fetch('https://api.spotify.com/v1/me/player', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${access_token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [body.device_id], play: body.play ?? false }),
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
