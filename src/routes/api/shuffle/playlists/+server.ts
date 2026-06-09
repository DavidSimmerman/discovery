// The user's Spotify playlists, for the shuffle-source picker. Summaries only —
// unrated counts need each playlist's full track list, so the client fetches
// those progressively from /api/shuffle/playlists/[id]/stats.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchMyPlaylists, SpotifyApiError } from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const token = await getValidAccessToken(locals.user.id);

  try {
    const playlists = await fetchMyPlaylists(token.access_token);
    return json({ playlists });
  } catch (e) {
    // 403 = playlist-read scopes not granted yet (token predates them). The
    // client shows a "log out and back in" prompt on this.
    if (e instanceof SpotifyApiError && e.status === 403) {
      return json({ playlists: null, reason: 'missing-scope' }, { status: 200 });
    }
    throw e;
  }
};
