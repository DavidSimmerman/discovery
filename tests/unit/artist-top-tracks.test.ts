import { describe, it, expect, vi } from 'vitest';

// Stub the SvelteKit-server imports the module touches so the pure helpers can
// be imported without spinning up env/db.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/schema', () => ({
  artistTopTracks: {},
  ratings: {},
  tracks: {},
}));
vi.mock('$lib/server/shuffle/providers/lastfm', () => ({ fetchArtistTopTracks: vi.fn() }));
vi.mock('$lib/server/spotify', () => ({ searchTracks: vi.fn() }));
vi.mock('$lib/server/library', () => ({ listArtists: vi.fn() }));
vi.mock('$lib/server/tracks', () => ({ largestAlbumArtUrl: () => null }));

import {
  normalizeArtistKey,
  normalizeTitle,
  pickTopUnrated,
  pickTopPopular,
  type CacheRow,
} from '$lib/server/artist-top-tracks';

describe('normalizeArtistKey', () => {
  it('trims and lowercases', () => {
    expect(normalizeArtistKey('  The Lumineers ')).toBe('the lumineers');
    expect(normalizeArtistKey('BØRNS')).toBe('børns');
  });
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation/spacing', () => {
    expect(normalizeTitle('Ho Hey')).toBe('hohey');
    expect(normalizeTitle('Sleep On The Floor')).toBe('sleeponthefloor');
  });
  it('matches across punctuation differences', () => {
    expect(normalizeTitle("Don't Stop")).toBe(normalizeTitle('dont stop'));
  });
});

function row(rank: number, uri: string | null, isrc: string | null, playcount = 0): CacheRow {
  return { rank, lastfmTitle: `T${rank}`, spotifyTrackUri: uri, isrc, album: null, albumArtUrl: null, playcount };
}

describe('pickTopUnrated', () => {
  it('drops unmatched (null URI) and already-rated (by uri or isrc), keeps rank order', () => {
    const rows: CacheRow[] = [
      row(5, 'uri:e', null, 60),
      row(1, 'uri:a', 'ISRC_A', 100),
      row(2, null, null, 90), // unmatched → drop
      row(3, 'uri:c', 'ISRC_C', 80), // rated by uri → drop
      row(4, 'uri:d', 'ISRC_D', 70), // rated by isrc → drop
    ];
    const out = pickTopUnrated(rows, new Set(['uri:c']), new Set(['ISRC_D']), 10);
    expect(out.map((t) => t.uri)).toEqual(['uri:a', 'uri:e']);
    expect(out[0].playcount).toBe(100);
  });

  it('caps at the limit', () => {
    const rows: CacheRow[] = [1, 2, 3, 4].map((r) => row(r, `uri:${r}`, null, 100 - r));
    const out = pickTopUnrated(rows, new Set(), new Set(), 2);
    expect(out.map((t) => t.uri)).toEqual(['uri:1', 'uri:2']);
  });

  it('returns empty when everything is filtered out', () => {
    const rows: CacheRow[] = [row(1, null, null), row(2, 'uri:b', null)];
    expect(pickTopUnrated(rows, new Set(['uri:b']), new Set(), 10)).toEqual([]);
  });
});

describe('pickTopPopular', () => {
  it('keeps all resolved tracks in rank order and annotates ratings', () => {
    const rows: CacheRow[] = [
      row(2, 'uri:b', 'ISRC_B', 90),
      row(1, 'uri:a', 'ISRC_A', 100),
      row(3, null, null, 80), // unresolved → dropped
    ];
    const out = pickTopPopular(rows, new Map([['uri:a', 5]]), new Map([['ISRC_B', 3]]), 10);
    expect(out.map((t) => [t.uri, t.rating])).toEqual([
      ['uri:a', 5],
      ['uri:b', 3],
    ]);
  });

  it('rates by ISRC when the URI differs, else null', () => {
    const rows: CacheRow[] = [row(1, 'uri:x', 'ISRC_X'), row(2, 'uri:y', null)];
    const out = pickTopPopular(rows, new Map(), new Map([['ISRC_X', 4]]), 10);
    expect(out[0].rating).toBe(4); // matched via ISRC
    expect(out[1].rating).toBeNull(); // no rating
  });

  it('caps at the limit', () => {
    const rows: CacheRow[] = [1, 2, 3].map((r) => row(r, `uri:${r}`, null));
    expect(pickTopPopular(rows, new Map(), new Map(), 2).map((t) => t.uri)).toEqual(['uri:1', 'uri:2']);
  });
});
