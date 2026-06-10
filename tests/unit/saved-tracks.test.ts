// Liked Songs as a shuffle source: GET /v1/me/tracks pages map onto the same
// PlaylistTrack shape playlists use; a 1-item probe powers the pseudo-snapshot
// (saved tracks have no snapshot_id).

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$env/static/private', () => ({
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
}));
vi.mock('$env/static/public', () => ({ PUBLIC_BASE_URL: 'http://localhost' }));

import { fetchSavedTracks, fetchSavedTracksProbe } from '$lib/server/spotify';

const calls: string[] = [];
function mockFetch(pages: unknown[]) {
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      const json = pages[Math.min(i++, pages.length - 1)];
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }),
  );
}

afterEach(() => {
  calls.length = 0;
  vi.unstubAllGlobals();
});

const saved = (uri: string, addedAt = '2026-06-01T00:00:00Z') => ({
  added_at: addedAt,
  track: {
    uri,
    name: 'Song',
    explicit: false,
    external_ids: { isrc: 'QZXYZ7654321' },
    artists: [{ id: 'a1', name: 'Artist' }],
  },
});

describe('fetchSavedTracks', () => {
  it('pages /v1/me/tracks at limit 50 and maps to PlaylistTrack', async () => {
    mockFetch([
      {
        next: 'https://api.spotify.com/v1/me/tracks?offset=50&limit=50',
        items: [saved('spotify:track:aaaaaaaaaaaaaaaaaaaaaa')],
      },
      { next: null, items: [saved('spotify:track:bbbbbbbbbbbbbbbbbbbbbb')] },
    ]);
    const out = await fetchSavedTracks('tok');
    const first = new URL(calls[0]);
    expect(first.pathname).toBe('/v1/me/tracks');
    expect(first.searchParams.get('limit')).toBe('50');
    expect(out).toEqual([
      {
        uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
        name: 'Song',
        artists: [{ id: 'a1', name: 'Artist' }],
        explicit: false,
        isrc: 'QZXYZ7654321',
      },
      {
        uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb',
        name: 'Song',
        artists: [{ id: 'a1', name: 'Artist' }],
        explicit: false,
        isrc: 'QZXYZ7654321',
      },
    ]);
  });

  it('drops local files / episodes (non spotify:track: URIs)', async () => {
    mockFetch([
      {
        next: null,
        items: [saved('spotify:local:xyz'), saved('spotify:track:cccccccccccccccccccccc')],
      },
    ]);
    const out = await fetchSavedTracks('tok');
    expect(out.map((t) => t.uri)).toEqual(['spotify:track:cccccccccccccccccccccc']);
  });
});

describe('fetchSavedTracksProbe', () => {
  it('asks for one item and returns total + newest added_at', async () => {
    mockFetch([
      { total: 1234, items: [saved('spotify:track:aaaaaaaaaaaaaaaaaaaaaa', '2026-06-09T12:00:00Z')] },
    ]);
    const probe = await fetchSavedTracksProbe('tok');
    expect(new URL(calls[0]).searchParams.get('limit')).toBe('1');
    expect(probe).toEqual({ total: 1234, newestAddedAt: '2026-06-09T12:00:00Z' });
  });

  it('empty library → total 0, empty cursor', async () => {
    mockFetch([{ total: 0, items: [] }]);
    const probe = await fetchSavedTracksProbe('tok');
    expect(probe).toEqual({ total: 0, newestAddedAt: '' });
  });
});
