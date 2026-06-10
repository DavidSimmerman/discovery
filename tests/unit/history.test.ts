import { describe, it, expect, vi } from 'vitest';

// mergeHistory is pure, but history.ts imports server-only deps at module load
// (db client, Spotify wrapper). Stub them so importing the module doesn't open a
// real DB connection — none are touched by mergeHistory itself.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/spotify', () => ({ fetchRecentlyPlayed: vi.fn() }));
vi.mock('$lib/server/tracks', () => ({ largestAlbumArtUrl: vi.fn() }));

import { mergeHistory, type TrackMeta } from '$lib/server/history';

type RawPlay = { uri: string; playedAtMs: number; source: 'spotify' | 'discovery' };

const meta = (over: Partial<TrackMeta> = {}): TrackMeta => ({
  title: 'T',
  artists: ['A'],
  albumArtUrl: null,
  album: null,
  isrc: null,
  ...over,
});

const U1 = 'spotify:track:1111111111111111111111';
const U2 = 'spotify:track:2222222222222222222222';
const U3 = 'spotify:track:3333333333333333333333';

describe('mergeHistory', () => {
  it('dedupes repeated plays into one row with combined count and latest play', () => {
    const plays: RawPlay[] = [
      { uri: U1, playedAtMs: 1_000, source: 'spotify' },
      { uri: U1, playedAtMs: 3_000, source: 'spotify' },
      { uri: U1, playedAtMs: 2_000, source: 'discovery' },
    ];
    const { rows } = mergeHistory(plays, new Map([[U1, meta()]]), new Map(), new Map(), {
      includeRated: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].playCount).toBe(3);
    expect(rows[0].playedAtMs).toBe(3_000);
    expect(rows[0].playedAt).toBe(new Date(3_000).toISOString());
  });

  it('counts a feed item and its ingested log row as ONE play', () => {
    // listHistory merges the Spotify feed AND the local plays log — but the log
    // now contains the feed's own just-ingested rows (same uri, same timestamp,
    // both labeled spotify). Those are the same play record, not two listens.
    const plays: RawPlay[] = [
      { uri: U1, playedAtMs: 1_000, source: 'spotify' }, // from the feed
      { uri: U1, playedAtMs: 1_000, source: 'spotify' }, // its ingested log row
    ];
    const { rows } = mergeHistory(plays, new Map([[U1, meta()]]), new Map(), new Map(), {
      includeRated: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].playCount).toBe(1);
    expect(rows[0].source).toBe('spotify');
  });

  it('marks source as both / spotify / discovery correctly', () => {
    const plays: RawPlay[] = [
      { uri: U1, playedAtMs: 1, source: 'spotify' },
      { uri: U1, playedAtMs: 2, source: 'discovery' },
      { uri: U2, playedAtMs: 1, source: 'spotify' },
      { uri: U3, playedAtMs: 1, source: 'discovery' },
    ];
    const m = new Map([
      [U1, meta()],
      [U2, meta()],
      [U3, meta()],
    ]);
    const { rows } = mergeHistory(plays, m, new Map(), new Map(), { includeRated: true });
    const byUri = Object.fromEntries(rows.map((r) => [r.uri, r.source]));
    expect(byUri[U1]).toBe('both');
    expect(byUri[U2]).toBe('spotify');
    expect(byUri[U3]).toBe('discovery');
  });

  it('resolves rating directly by URI and falls back to ISRC', () => {
    const plays: RawPlay[] = [
      { uri: U1, playedAtMs: 1, source: 'spotify' },
      { uri: U2, playedAtMs: 1, source: 'spotify' },
      { uri: U3, playedAtMs: 1, source: 'spotify' },
    ];
    const m = new Map([
      [U1, meta({ isrc: 'ISRC_A' })], // rated directly
      [U2, meta({ isrc: 'ISRC_B' })], // rated only via ISRC
      [U3, meta({ isrc: 'ISRC_C' })], // unrated
    ]);
    const ratingByUri = new Map([[U1, 5]]);
    const ratingByIsrc = new Map([['ISRC_B', 3]]);
    const { rows } = mergeHistory(plays, m, ratingByUri, ratingByIsrc, { includeRated: true });
    const byUri = Object.fromEntries(rows.map((r) => [r.uri, r.rating]));
    expect(byUri[U1]).toBe(5);
    expect(byUri[U2]).toBe(3);
    expect(byUri[U3]).toBe(null);
  });

  it('unratedCount counts all unrated regardless of the includeRated filter', () => {
    const plays: RawPlay[] = [
      { uri: U1, playedAtMs: 1, source: 'spotify' },
      { uri: U2, playedAtMs: 2, source: 'spotify' },
      { uri: U3, playedAtMs: 3, source: 'spotify' },
    ];
    const m = new Map([
      [U1, meta()],
      [U2, meta()],
      [U3, meta()],
    ]);
    const ratingByUri = new Map([[U1, 4]]); // one rated, two unrated

    const all = mergeHistory(plays, m, ratingByUri, new Map(), { includeRated: true });
    expect(all.unratedCount).toBe(2);
    expect(all.rows).toHaveLength(3);

    const unratedOnly = mergeHistory(plays, m, ratingByUri, new Map(), { includeRated: false });
    expect(unratedOnly.unratedCount).toBe(2);
    expect(unratedOnly.rows).toHaveLength(2);
    expect(unratedOnly.rows.every((r) => r.rating == null)).toBe(true);
  });

  it('sorts newest-first, tiebreaking by uri', () => {
    const plays: RawPlay[] = [
      { uri: U2, playedAtMs: 5_000, source: 'spotify' },
      { uri: U1, playedAtMs: 9_000, source: 'spotify' },
      { uri: U3, playedAtMs: 5_000, source: 'spotify' },
    ];
    const m = new Map([
      [U1, meta()],
      [U2, meta()],
      [U3, meta()],
    ]);
    const { rows } = mergeHistory(plays, m, new Map(), new Map(), { includeRated: true });
    // U1 newest; U2 and U3 tie on time → ascending uri (U2 before U3).
    expect(rows.map((r) => r.uri)).toEqual([U1, U2, U3]);
  });

  it('tolerates missing metadata (renders nulls)', () => {
    const plays: RawPlay[] = [{ uri: U1, playedAtMs: 1, source: 'discovery' }];
    const { rows } = mergeHistory(plays, new Map(), new Map(), new Map(), { includeRated: true });
    expect(rows[0]).toMatchObject({ uri: U1, title: null, artists: [], albumArtUrl: null });
  });
});
