import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';
import { getArtistStats, getArtistTopUnrated } from '$lib/server/artist-top-tracks';

// Artist-tab "discovery" payload for the now-playing screen: the artist's stats
// (avg rating / composite rating / rank — same numbers as the library list) plus
// the top unrated tracks by Last.fm playcount. Loaded lazily when the user opens
// the Artist tab; the top-unrated lookup may hit Last.fm + Spotify on a cache
// miss, so this is intentionally not preloaded on every track change.
export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const name = (params.name ?? '').trim();
  if (name === '') return json({ stats: null, topUnrated: [] });

  const { access_token } = await getValidAccessToken(userId);

  const [stats, topUnrated] = await Promise.all([
    getArtistStats(userId, name),
    getArtistTopUnrated(userId, name, access_token, 10),
  ]);

  // Per-user payload (stats + top-unrated are filtered by the reader's ratings)
  // but the URL is keyed only by artist name — never let a browser/proxy/CDN
  // reuse one user's rating-filtered response for another.
  return json({ stats, topUnrated }, { headers: { 'cache-control': 'no-store' } });
};
