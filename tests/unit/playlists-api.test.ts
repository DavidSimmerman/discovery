// Feb-2026 Spotify API migration: playlist payloads renamed `tracks` → `items`
// and /playlists/{id}/tracks → /playlists/{id}/items (items[].track → items[].item).
// These tests pin the new shapes (with legacy fallback for /me/playlists).

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$env/static/private', () => ({
  SPOTIFY_CLIENT_ID: 'cid',
  SPOTIFY_CLIENT_SECRET: 'secret',
}));
vi.mock('$env/static/public', () => ({ PUBLIC_BASE_URL: 'http://localhost' }));

import { fetchMyPlaylists, fetchPlaylistTracks } from '$lib/server/spotify';

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

describe('fetchMyPlaylists — Feb-2026 shape', () => {
  it('reads totals from the renamed `items` field', async () => {
    mockFetch([
      {
        next: null,
        items: [
          {
            id: 'p1',
            name: 'Rap',
            images: [{ url: 'img1' }],
            items: { total: 42 },
            snapshot_id: 'snap1',
          },
        ],
      },
    ]);
    const out = await fetchMyPlaylists('tok');
    expect(out).toEqual([
      { id: 'p1', name: 'Rap', imageUrl: 'img1', total: 42, snapshotId: 'snap1' },
    ]);
  });

  it('falls back to legacy `tracks.total` when `items` is absent', async () => {
    mockFetch([
      {
        next: null,
        items: [{ id: 'p2', name: 'Old', images: null, tracks: { total: 7 }, snapshot_id: 's' }],
      },
    ]);
    const out = await fetchMyPlaylists('tok');
    expect(out[0].total).toBe(7);
  });

  it('missing both → total 0', async () => {
    mockFetch([{ next: null, items: [{ id: 'p3', name: 'X', snapshot_id: 's' }] }]);
    const out = await fetchMyPlaylists('tok');
    expect(out[0].total).toBe(0);
  });
});

describe('fetchPlaylistTracks — /items endpoint', () => {
  const page = (items: unknown[], next: string | null = null) => ({ next, items });
  const item = (uri: string, over: Record<string, unknown> = {}) => ({
    item: {
      uri,
      name: 'Song',
      explicit: false,
      external_ids: { isrc: 'QZABC1234567' },
      artists: [{ id: 'a1', name: 'Artist' }],
      ...over,
    },
  });

  it('calls /playlists/{id}/items with item-shaped fields', async () => {
    mockFetch([page([])]);
    await fetchPlaylistTracks('tok', 'pl1');
    const u = new URL(calls[0]);
    expect(u.pathname).toBe('/v1/playlists/pl1/items');
    expect(decodeURIComponent(u.searchParams.get('fields') ?? '')).toContain('items(item(');
  });

  it('parses items[].item and keeps only spotify:track: URIs', async () => {
    mockFetch([
      page([
        item('spotify:track:aaaaaaaaaaaaaaaaaaaaaa'),
        item('spotify:episode:bbbbbbbbbbbbbbbbbbbbbb'),
        { item: null },
      ]),
    ]);
    const out = await fetchPlaylistTracks('tok', 'pl1');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
      name: 'Song',
      artists: [{ id: 'a1', name: 'Artist' }],
      explicit: false,
      isrc: 'QZABC1234567',
    });
  });

  it('follows pagination via next', async () => {
    mockFetch([
      page([item('spotify:track:aaaaaaaaaaaaaaaaaaaaaa')], 'https://api.spotify.com/v1/playlists/pl1/items?offset=100'),
      page([item('spotify:track:cccccccccccccccccccccc')]),
    ]);
    const out = await fetchPlaylistTracks('tok', 'pl1');
    expect(out.map((t) => t.uri)).toEqual([
      'spotify:track:aaaaaaaaaaaaaaaaaaaaaa',
      'spotify:track:cccccccccccccccccccccc',
    ]);
  });
});
