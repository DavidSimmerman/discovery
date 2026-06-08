import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import {
  getArtistStats,
  getArtistTopPopular,
  getArtistTopUnrated,
} from '$lib/server/artist-top-tracks';

// Artist "discovery" payload: the artist's stats (avg rating / composite rating
// / rank — same numbers as the library list) plus a popularity-ranked track
// list. Two list modes, both ranked by Last.fm playcount:
//   default        → topUnrated: only tracks the reader hasn't rated (now-playing
//                    Artist tab + song-details page).
//   ?list=popular  → topPopular: every catalog track, annotated with the reader's
//                    rating (the library artist page).
// Loaded lazily; the lookup may hit Last.fm + Spotify on a cache miss.
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const name = (params.name ?? '').trim();
  const wantPopular = url.searchParams.get('list') === 'popular';
  if (name === '') {
    return json(wantPopular ? { stats: null, topPopular: [] } : { stats: null, topUnrated: [] });
  }

  const { access_token } = await getValidAccessToken(userId);

  const [stats, tracks] = await Promise.all([
    getArtistStats(userId, name),
    wantPopular
      ? getArtistTopPopular(userId, name, access_token, 30)
      : getArtistTopUnrated(userId, name, access_token, 10),
  ]);

  // Per-user payload (ratings-filtered/annotated) keyed in the URL only by artist
  // name — never let a browser/proxy/CDN reuse one user's response for another.
  const body = wantPopular ? { stats, topPopular: tracks } : { stats, topUnrated: tracks };
  return json(body, { headers: { 'cache-control': 'no-store' } });
};
