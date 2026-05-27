import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError } from '$lib/playback/errors';

interface UrisBody { uris: string[]; device_id?: string }
interface ContextBody {
  context_uri: string;
  offset?: { uri: string } | { position: number };
  position_ms?: number;
  device_id?: string;
}

type Body = Partial<UrisBody> & Partial<ContextBody>;

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = (await request.json()) as Body;
  const hasUris = Array.isArray(body.uris);
  const hasContext = typeof body.context_uri === 'string';
  if (!hasUris && !hasContext) {
    throw error(400, 'one of { uris, context_uri } is required');
  }

  const { access_token } = await getValidAccessToken(locals.user.id);

  const payload: Record<string, unknown> = {};
  if (hasUris) payload.uris = body.uris;
  if (hasContext) {
    payload.context_uri = body.context_uri;
    if (body.offset) payload.offset = body.offset;
    if (typeof body.position_ms === 'number') payload.position_ms = body.position_ms;
  }

  // device_id is optional: when absent, Spotify routes to whichever device the
  // user has marked active. Surfaces no_active_device (409) when nothing is.
  const qs = body.device_id ? `?device_id=${encodeURIComponent(body.device_id)}` : '';
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/play${qs}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (res.ok) return new Response(null, { status: 204 });

  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* leave as {} */ }
  const mapped = mapSpotifyPlayError(res.status, parsed, res.headers.get('retry-after'));
  // Translate to HTTP status the client can switch on.
  const clientStatus =
    mapped.error === 'no_active_device' ? 409 :
    mapped.error === 'premium_required' ? 402 :
    mapped.error === 'rate_limited' ? 429 :
    502;
  return json(mapped, { status: clientStatus });
};
