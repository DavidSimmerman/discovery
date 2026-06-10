// Snapshot-keyed in-memory cache for playlist track lists.
//
// Why: the shuffle endpoints rebuild their candidate pool on every call, and a
// 1,000+ track playlist costs ~12 paginated Spotify requests to read. Spotify
// versions playlists with `snapshot_id`, so a (playlistId, snapshotId) pair is
// immutable — cache hits are exact, never stale. Entries are evicted on a
// byte-cheap LRU-ish cap plus a TTL backstop (snapshot ids of deleted
// playlists would otherwise pin memory forever).
//
// Keys are scoped by USER, not just playlist: a cache hit must never let user
// B read a private playlist that only user A's token could fetch. The cost is
// duplicate entries for a playlist two users both selected — acceptable.
//
// Single-process cache (the app runs as one Node instance). If that changes,
// swap the Map for a real store; the call shape stays the same.

import {
  fetchPlaylistTracks,
  fetchSavedTracks,
  fetchSavedTracksProbe,
  fetchPageWithRetry,
  SpotifyApiError,
  type PlaylistTrack,
} from '$lib/server/spotify';
import { isLikedSongs } from '$lib/liked';

type Entry = { tracks: PlaylistTrack[]; cachedAt: number };

const TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 50;

const cache = new Map<string, Entry>(); // key: `${userId}:${playlistId}@${snapshotId}`

export async function getPlaylistTracksCached(
  accessToken: string,
  userId: string,
  playlistId: string,
  snapshotId: string,
  now = Date.now(),
): Promise<PlaylistTrack[]> {
  const key = `${userId}:${playlistId}@${snapshotId}`;
  const hit = cache.get(key);
  if (hit && now - hit.cachedAt < TTL_MS) {
    // Refresh recency: Map iteration order is insertion order, so re-inserting
    // makes the eviction loop below behave LRU instead of FIFO.
    cache.delete(key);
    cache.set(key, hit);
    return hit.tracks;
  }

  let tracks: PlaylistTrack[];
  try {
    tracks = isLikedSongs(playlistId)
      ? await fetchSavedTracks(accessToken)
      : await fetchPlaylistTracks(accessToken, playlistId);
  } catch (e) {
    // Stale-on-error: Spotify is flaking (503 bursts) — any cached snapshot of
    // this playlist beats failing the caller. Snapshot mismatch just means the
    // data is minutes-to-hours old, which stats/shuffle can absorb.
    const stale = newestEntryFor(userId, playlistId, now);
    if (stale) {
      console.warn('[playlistCache] serving stale tracks after fetch failure', {
        playlistId,
        status: e instanceof SpotifyApiError ? e.status : null,
      });
      return stale;
    }
    throw e;
  }
  cache.set(key, { tracks, cachedAt: now });

  // Drop this user's stale snapshots of the same playlist, then enforce the cap.
  for (const k of cache.keys()) {
    if (k !== key && k.startsWith(`${userId}:${playlistId}@`)) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return tracks;
}

// Newest cached track list for a playlist regardless of snapshot — the
// stale-on-error path above. TTL still applies; beyond it, stale is too stale.
function newestEntryFor(userId: string, playlistId: string, now: number): PlaylistTrack[] | null {
  let best: Entry | null = null;
  for (const [k, v] of cache) {
    if (!k.startsWith(`${userId}:${playlistId}@`)) continue;
    if (now - v.cachedAt >= TTL_MS) continue;
    if (!best || v.cachedAt > best.cachedAt) best = v;
  }
  return best?.tracks ?? null;
}

// Short-TTL cache for playlist snapshot ids, so the shuffle endpoints don't
// hit GET /playlists/{id} on every pick just to learn "nothing changed".
// 60s staleness means a freshly-edited playlist takes up to a minute to be
// picked up mid-session — fine for this use. Also user-scoped: resolving a
// snapshot id proves the token can access the playlist, and the tracks cache
// above trusts that proof.
const SNAPSHOT_TTL_MS = 60_000;
const snapshots = new Map<string, { snapshotId: string; cachedAt: number }>();

export async function getPlaylistSnapshotCached(
  accessToken: string,
  userId: string,
  playlistId: string,
  now = Date.now(),
): Promise<string> {
  const key = `${userId}:${playlistId}`;
  const hit = snapshots.get(key);
  if (hit && now - hit.cachedAt < SNAPSHOT_TTL_MS) return hit.snapshotId;

  try {
    // Liked Songs has no snapshot_id; total + newest added_at stand in for one.
    if (isLikedSongs(playlistId)) {
      const probe = await fetchSavedTracksProbe(accessToken);
      const snapshotId = `liked:${probe.total}:${probe.newestAddedAt}`;
      snapshots.set(key, { snapshotId, cachedAt: now });
      return snapshotId;
    }

    const res = await fetchPageWithRetry(
      `https://api.spotify.com/v1/playlists/${playlistId}?fields=snapshot_id`,
      accessToken,
      'playlist snapshot',
    );
    const json: { snapshot_id?: string } = await res.json();
    const snapshotId = json.snapshot_id ?? '';
    snapshots.set(key, { snapshotId, cachedAt: now });
    return snapshotId;
  } catch (e) {
    // Stale-on-error: an expired-but-known snapshot id keeps the cached track
    // list reachable through a 503 burst. Worst case the data trails reality
    // by however long Spotify stays down.
    if (hit) {
      console.warn('[playlistCache] serving stale snapshot after probe failure', {
        playlistId,
        status: e instanceof SpotifyApiError ? e.status : null,
      });
      return hit.snapshotId;
    }
    throw e;
  }
}

// Test hook.
export function clearPlaylistCache(): void {
  cache.clear();
  snapshots.clear();
}
