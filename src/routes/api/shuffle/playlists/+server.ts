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
import { db } from '$lib/server/db';
import { playlistTrackCache } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

// Catalogue caching, stale-while-revalidate:
//   fresh (<5 min)  → serve memory, no Spotify call
//   stale (<24 h)   → serve immediately, refresh in the background
//   cold process    → DB copy (sentinel row in playlist_track_cache) serves
//                     instantly while a refresh runs; only a never-seen user
//                     pays a blocking Spotify crawl
// Spotify is slow + 5xx-bursty for dev-mode apps right now; opening the
// sources panel must not re-pay that cost every time.
const FRESH_MS = 5 * 60_000;
const LAST_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOGUE_SENTINEL = '__catalogue__'; // playlist_track_cache row reuse
const lastGood = new Map<string, { playlists: SpotifyPlaylistSummary[]; at: number }>();
const refreshing = new Set<string>();

async function crawlCatalogue(accessToken: string): Promise<SpotifyPlaylistSummary[]> {
  const [playlists, liked] = await Promise.all([
    fetchMyPlaylists(accessToken),
    // Liked Songs isn't a playlist; inject it, pinned first. Best-effort —
    // a probe failure shouldn't take the real playlists down with it.
    fetchSavedTracksProbe(accessToken).catch(() => null),
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
  return playlists;
}

async function refreshCatalogue(userId: string, accessToken: string): Promise<SpotifyPlaylistSummary[]> {
  const playlists = await crawlCatalogue(accessToken);
  lastGood.set(userId, { playlists: [...playlists], at: Date.now() });
  // Persist for cold-process serves; the tracks column carries summaries for
  // this sentinel row (it's a cache table — shape is whatever the id implies).
  void db
    .insert(playlistTrackCache)
    .values({ userId, playlistId: CATALOGUE_SENTINEL, snapshotId: '', tracks: playlists, cachedAt: new Date() })
    .onConflictDoUpdate({
      target: [playlistTrackCache.userId, playlistTrackCache.playlistId],
      set: { tracks: playlists, cachedAt: new Date() },
    })
    .catch((err) => console.error('[playlists] persist failed', { userId, err }));
  return playlists;
}

function kickBackgroundRefresh(userId: string, accessToken: string): void {
  if (refreshing.has(userId)) return;
  refreshing.add(userId);
  void refreshCatalogue(userId, accessToken)
    .catch((err) => console.warn('[playlists] background refresh failed', { userId, err: String(err) }))
    .finally(() => refreshing.delete(userId));
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const token = await getValidAccessToken(userId);

  const cached = lastGood.get(userId);
  if (cached && Date.now() - cached.at < FRESH_MS) {
    return json({ playlists: cached.playlists });
  }
  if (cached && Date.now() - cached.at < LAST_GOOD_TTL_MS) {
    kickBackgroundRefresh(userId, token.access_token);
    return json({ playlists: cached.playlists, stale: true });
  }

  // Cold process: DB copy serves instantly while a refresh runs.
  const rows = await db
    .select()
    .from(playlistTrackCache)
    .where(and(eq(playlistTrackCache.userId, userId), eq(playlistTrackCache.playlistId, CATALOGUE_SENTINEL)))
    .limit(1);
  const dbRow = rows[0];
  if (dbRow && Date.now() - dbRow.cachedAt.getTime() < LAST_GOOD_TTL_MS) {
    const playlists = dbRow.tracks as SpotifyPlaylistSummary[];
    lastGood.set(userId, { playlists, at: dbRow.cachedAt.getTime() });
    kickBackgroundRefresh(userId, token.access_token);
    return json({ playlists, stale: true });
  }

  try {
    const playlists = await refreshCatalogue(userId, token.access_token);
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
