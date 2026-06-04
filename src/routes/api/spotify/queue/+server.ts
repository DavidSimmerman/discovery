// Diagnostic proxy for Spotify's GET /me/player/queue. We push tracks into
// Spotify's user-queue (POST /me/player/queue) but have no API to read back
// what actually landed there or in what order — which is exactly the boundary
// where native NEXT/PREV bugs live. This endpoint lets the client log Spotify's
// REAL queue alongside our virtual timeline so divergence is visible.
//
// Returns a slimmed payload (uri + name + artists only) to keep it light.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';

type SpotifyItem = { uri?: string; name?: string; artists?: { name?: string }[] } | null;
function slim(t: SpotifyItem) {
  if (!t) return null;
  return { uri: t.uri ?? null, name: t.name ?? null, artists: (t.artists ?? []).map((a) => a.name ?? '') };
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const { access_token } = await getValidAccessToken(locals.user.id);

  const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!res.ok) {
    // 204 (no active device) or other — return an empty shape so the client
    // logger doesn't have to special-case errors.
    return json({ currently_playing: null, queue: [] }, { headers: { 'cache-control': 'no-store' } });
  }

  const data = (await res.json()) as { currently_playing?: SpotifyItem; queue?: SpotifyItem[] };
  return json(
    {
      currently_playing: slim(data.currently_playing ?? null),
      queue: Array.isArray(data.queue) ? data.queue.map(slim) : [],
    },
    { headers: { 'cache-control': 'no-store' } },
  );
};
