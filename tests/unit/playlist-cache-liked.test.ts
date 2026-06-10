// The playlist cache routes the Liked Songs sentinel to the saved-tracks
// fetchers — everything downstream (stats, sources, sampler) is unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchPlaylistTracks = vi.fn();
const fetchSavedTracks = vi.fn();
const fetchSavedTracksProbe = vi.fn();

vi.mock('$lib/server/spotify', () => ({
  fetchPlaylistTracks: (...a: unknown[]) => fetchPlaylistTracks(...a),
  fetchSavedTracks: (...a: unknown[]) => fetchSavedTracks(...a),
  fetchSavedTracksProbe: (...a: unknown[]) => fetchSavedTracksProbe(...a),
  SpotifyApiError: class extends Error {
    constructor(public status: number, msg: string) {
      super(msg);
    }
  },
}));

import {
  getPlaylistTracksCached,
  getPlaylistSnapshotCached,
  clearPlaylistCache,
} from '$lib/server/shuffle/playlist-cache';
import { LIKED_SONGS_ID } from '$lib/liked';

beforeEach(() => {
  clearPlaylistCache();
  vi.clearAllMocks();
});

describe('liked-songs sentinel routing', () => {
  it('tracks: sentinel id → fetchSavedTracks, not the playlist endpoint', async () => {
    const tracks = [{ uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa' }];
    fetchSavedTracks.mockResolvedValue(tracks);
    const out = await getPlaylistTracksCached('tok', 'u1', LIKED_SONGS_ID, 'snap1');
    expect(out).toBe(tracks);
    expect(fetchSavedTracks).toHaveBeenCalledWith('tok');
    expect(fetchPlaylistTracks).not.toHaveBeenCalled();
  });

  it('tracks: cache hit on same pseudo-snapshot skips the refetch', async () => {
    fetchSavedTracks.mockResolvedValue([]);
    await getPlaylistTracksCached('tok', 'u1', LIKED_SONGS_ID, 'snapA');
    await getPlaylistTracksCached('tok', 'u1', LIKED_SONGS_ID, 'snapA');
    expect(fetchSavedTracks).toHaveBeenCalledTimes(1);
  });

  it('snapshot: sentinel id → probe-derived pseudo-snapshot', async () => {
    fetchSavedTracksProbe.mockResolvedValue({ total: 321, newestAddedAt: '2026-06-09T12:00:00Z' });
    const snap = await getPlaylistSnapshotCached('tok', 'u1', LIKED_SONGS_ID);
    expect(snap).toBe('liked:321:2026-06-09T12:00:00Z');
  });

  it('real playlist ids still use the playlist endpoint', async () => {
    fetchPlaylistTracks.mockResolvedValue([]);
    await getPlaylistTracksCached('tok', 'u1', 'realPlaylistId123', 'snap1');
    expect(fetchPlaylistTracks).toHaveBeenCalledWith('tok', 'realPlaylistId123');
    expect(fetchSavedTracks).not.toHaveBeenCalled();
  });
});
