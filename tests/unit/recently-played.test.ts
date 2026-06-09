import { describe, it, expect, vi, afterEach } from 'vitest';

// spotify.ts reads these at module load; provide stubs so it imports cleanly.
vi.mock('$env/static/private', () => ({
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
}));
vi.mock('$env/static/public', () => ({ PUBLIC_BASE_URL: 'http://localhost' }));

import { fetchRecentlyPlayed, SpotifyApiError } from '$lib/server/spotify';

let lastUrl = '';
function mockFetch(json: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      lastUrl = url;
      return { ok, status, json: async () => json } as unknown as Response;
    }),
  );
}

const trackItem = (uri: string, playedAt: string) => ({
  played_at: playedAt,
  track: {
    uri,
    name: 'Song',
    artists: [{ name: 'Artist' }],
    album: { name: 'Album', images: [] },
    duration_ms: 1000,
    external_ids: { isrc: 'ISRC1' },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchRecentlyPlayed', () => {
  it('sends limit (capped at 50) and the after cursor', async () => {
    mockFetch({ items: [] });
    await fetchRecentlyPlayed('tok', 1_700_000_000_000, 200);
    const u = new URL(lastUrl);
    expect(u.pathname).toBe('/v1/me/player/recently-played');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(u.searchParams.get('after')).toBe('1700000000000');
  });

  it('omits after when no cursor is given', async () => {
    mockFetch({ items: [] });
    await fetchRecentlyPlayed('tok');
    expect(new URL(lastUrl).searchParams.has('after')).toBe(false);
  });

  it('filters out non-track items (local files / podcasts / nulls)', async () => {
    mockFetch({
      items: [
        trackItem('spotify:track:aaaaaaaaaaaaaaaaaaaaaa', '2024-01-01T00:00:00Z'),
        { played_at: '2024-01-01T00:01:00Z', track: { uri: 'spotify:local:x' } },
        { played_at: '2024-01-01T00:02:00Z', track: null },
        { played_at: '2024-01-01T00:03:00Z' },
      ],
    });
    const out = await fetchRecentlyPlayed('tok');
    expect(out).toHaveLength(1);
    expect(out[0].track.uri).toBe('spotify:track:aaaaaaaaaaaaaaaaaaaaaa');
    expect(out[0].played_at).toBe('2024-01-01T00:00:00Z');
  });

  it('throws SpotifyApiError carrying the status on failure', async () => {
    mockFetch({}, false, 403);
    await expect(fetchRecentlyPlayed('tok')).rejects.toBeInstanceOf(SpotifyApiError);
    mockFetch({}, false, 403);
    await expect(fetchRecentlyPlayed('tok')).rejects.toMatchObject({ status: 403 });
  });
});
