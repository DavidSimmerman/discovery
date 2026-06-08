import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: { LASTFM_API_KEY: 'test-key' } }));

import { fetchArtistTopTracks } from '$lib/server/shuffle/providers/lastfm';

function mockFetch(json: unknown, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => json }) as unknown as Response),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchArtistTopTracks (Last.fm artist.gettoptracks)', () => {
  it('parses title, playcount, rank and mbid in order', async () => {
    mockFetch({
      toptracks: {
        track: [
          { name: 'Ophelia', playcount: '1234567', mbid: 'mbid-1', '@attr': { rank: '1' } },
          { name: 'Cleopatra', playcount: '890000', mbid: '', '@attr': { rank: '2' } },
        ],
      },
    });
    const out = await fetchArtistTopTracks('The Lumineers', 30);
    expect(out).toEqual([
      { title: 'Ophelia', playcount: 1234567, rank: 1, mbid: 'mbid-1' },
      { title: 'Cleopatra', playcount: 890000, rank: 2, mbid: null },
    ]);
  });

  it('falls back to array order when @attr.rank is absent', async () => {
    mockFetch({ toptracks: { track: [{ name: 'A', playcount: '5' }, { name: 'B', playcount: '3' }] } });
    const out = await fetchArtistTopTracks('x');
    expect(out.map((t) => t.rank)).toEqual([1, 2]);
  });

  it('drops entries with empty titles', async () => {
    mockFetch({ toptracks: { track: [{ name: '', playcount: '5' }, { name: 'B', playcount: '3' }] } });
    const out = await fetchArtistTopTracks('x');
    expect(out.map((t) => t.title)).toEqual(['B']);
  });

  it('returns [] on HTTP error and on Last.fm error payloads', async () => {
    mockFetch({}, false);
    expect(await fetchArtistTopTracks('x')).toEqual([]);
    mockFetch({ error: 6, message: 'not found' });
    expect(await fetchArtistTopTracks('x')).toEqual([]);
  });

  it('handles a single-object track (non-array)', async () => {
    mockFetch({ toptracks: { track: { name: 'Solo', playcount: '7', '@attr': { rank: '1' } } } });
    const out = await fetchArtistTopTracks('x');
    expect(out).toEqual([{ title: 'Solo', playcount: 7, rank: 1, mbid: null }]);
  });
});
