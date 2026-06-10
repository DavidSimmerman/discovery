// Diagnostic proxy for Spotify's GET /me/player/queue. We push tracks into
// Spotify's user-queue (POST /me/player/queue) but have no API to read back
// what actually landed there or in what order — which is exactly the boundary
// where native NEXT/PREV bugs live. This endpoint lets the client log Spotify's
// REAL queue alongside our virtual timeline so divergence is visible.
//
// Returns a slimmed payload (uri + name + artists + albumArtUrl) to keep it
// light. albumArtUrl rides along from Spotify's own track objects — the queue
// is the ONLY art source for unrated/discovery picks, which aren't in the
// local tracks table (the Queue tab's /api/tracks hydration knows nothing
// about them and they rendered as gray placeholder boxes).
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';

type SpotifyItem = {
  uri?: string;
  name?: string;
  artists?: { name?: string }[];
  album?: { images?: { url?: string }[] };
} | null;
function slim(t: SpotifyItem) {
  if (!t) return null;
  return {
    uri: t.uri ?? null,
    name: t.name ?? null,
    artists: (t.artists ?? []).map((a) => a.name ?? ''),
    albumArtUrl: t.album?.images?.[0]?.url ?? null,
  };
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const { access_token } = await getValidAccessToken(locals.user.id);

  const res = await fetch('https://api.spotify.com/v1/me/player/queue', {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!res.ok || res.status === 204) {
    // 204 (no active device / empty body — res.ok is TRUE for 204, so it must
    // be checked explicitly or res.json() throws) or other — return an empty
    // shape so the client logger doesn't have to special-case errors.
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
