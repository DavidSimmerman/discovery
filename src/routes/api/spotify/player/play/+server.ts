import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { mapSpotifyPlayError, type PlayErrorShape } from '$lib/playback/errors';
import { listDevices, pickBestDevice } from '$lib/server/playback/devices';
import { spotifyPlay } from '$lib/server/playback/spotify-play';

interface UrisBody { uris: string[]; position_ms?: number; device_id?: string }
interface ContextBody {
  context_uri: string;
  offset?: { uri: string } | { position: number };
  position_ms?: number;
  device_id?: string;
}

type Body = Partial<UrisBody> & Partial<ContextBody>;

async function mapFailure(res: Response): Promise<PlayErrorShape> {
  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { /* leave as {} */ }
  return mapSpotifyPlayError(res.status, parsed, res.headers.get('retry-after'));
}

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
  }
  // position_ms applies to BOTH payload shapes. The sampler's low-water
  // re-push sends { uris, position_ms } to continue the current track at its
  // offset — dropping it here restarted the song from 0 on every re-push.
  if (typeof body.position_ms === 'number') payload.position_ms = body.position_ms;

  let res = await spotifyPlay(access_token, payload, body.device_id);
  if (res.ok) return new Response(null, { status: 204 });

  let mapped = await mapFailure(res);

  // Silent device fallback: "no active device" usually just means Spotify is
  // backgrounded — it still shows up as an *available* device. Target it
  // explicitly and retry once. Skipped when the caller picked a device
  // themselves; their choice failing shouldn't silently re-route elsewhere.
  if (mapped.error === 'no_active_device' && !body.device_id) {
    const device = pickBestDevice(await listDevices(access_token));
    if (device?.id) {
      res = await spotifyPlay(access_token, payload, device.id);
      if (res.ok) return new Response(null, { status: 204 });
      mapped = await mapFailure(res);
    }
  }

  // Translate to HTTP status the client can switch on.
  const clientStatus =
    mapped.error === 'no_active_device' ? 409 :
    mapped.error === 'premium_required' ? 402 :
    mapped.error === 'rate_limited' ? 429 :
    502;
  return json(mapped, { status: clientStatus });
};
