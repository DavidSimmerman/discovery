// The user's Spotify playlists, for the shuffle-source picker. Summaries only —
// unrated counts need each playlist's full track list, so the client fetches
// those progressively from /api/shuffle/playlists/[id]/stats.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  fetchMyPlaylists,
  fetchSavedTracksProbe,
  SpotifyApiError,
} from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';
import { LIKED_SONGS_ID, LIKED_SONGS_NAME } from '$lib/liked';
import type { SpotifyPlaylistSummary } from '$lib/server/spotify';

// Last-known-good summaries per user. Spotify throws intermittent 5xxs at
// dev-mode apps; a stale sources list beats an empty error state — the
// snapshot-keyed stats/cache layers still verify freshness downstream.
const LAST_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
const lastGood = new Map<string, { playlists: SpotifyPlaylistSummary[]; at: number }>();

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const token = await getValidAccessToken(locals.user.id);

  try {
    const [playlists, liked] = await Promise.all([
      fetchMyPlaylists(token.access_token),
      // Liked Songs isn't a playlist; inject it, pinned first. Best-effort —
      // a probe failure shouldn't take the real playlists down with it.
      fetchSavedTracksProbe(token.access_token).catch(() => null),
    ]);
    if (liked) {
      playlists.unshift({
        id: LIKED_SONGS_ID,
        name: LIKED_SONGS_NAME,
        imageUrl: null,
        total: liked.total,
        snapshotId: `liked:${liked.total}:${liked.newestAddedAt}`,
      });
    }
    lastGood.set(locals.user.id, { playlists: [...playlists], at: Date.now() });
    return json({ playlists });
  } catch (e) {
    // 403 = playlist-read scopes not granted yet (token predates them). The
    // client shows a "log out and back in" prompt on this.
    if (e instanceof SpotifyApiError && e.status === 403) {
      return json({ playlists: null, reason: 'missing-scope' }, { status: 200 });
    }
    // Transient Spotify failure (survived the retry layer) → serve the last
    // good list instead of nuking the sources panel.
    const cached = lastGood.get(locals.user.id);
    if (e instanceof SpotifyApiError && cached && Date.now() - cached.at < LAST_GOOD_TTL_MS) {
      console.warn('[playlists] Spotify failed, serving last-known-good', {
        userId: locals.user.id,
        status: e.status,
        ageMs: Date.now() - cached.at,
      });
      return json({ playlists: cached.playlists, stale: true });
    }
    throw e;
  }
};
