import { describe, it, expect, vi } from 'vitest';

// Stub every SvelteKit-server import the module touches, so the pure helpers
// can be imported without spinning up env/db.
vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/db/schema', () => ({
  tracks: {},
  artists: {},
  trackArtists: {},
  ratings: {},
  trackWorks: {},
  trackCredits: {},
  trackSimilars: {},
}));
vi.mock('$lib/server/tokens', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('$lib/server/tracks', () => ({ largestAlbumArtUrl: () => null }));
vi.mock('$lib/server/shuffle/providers/reccobeats', () => ({ getCachedAudioFeatures: vi.fn() }));
vi.mock('$lib/server/shuffle/providers/musicbrainz', () => ({
  fetchRecordingByIsrc: vi.fn(),
  fetchWorkCredits: vi.fn(),
}));
vi.mock('$lib/server/shuffle/providers/lastfm', () => ({ fetchSimilarTracks: vi.fn() }));
vi.mock('$lib/server/spotify', () => ({
  fetchTracks: vi.fn(),
  fetchArtists: vi.fn(),
  fetchArtistTopTracks: vi.fn(),
  searchTrack: vi.fn(),
  idFromUri: (u: string) => u,
}));

import { computeDuplicateGroups, __test, type FamilyRow } from '../../src/lib/server/shuffle/enrichment';

describe('parseReleaseDate', () => {
  const parse = __test.parseReleaseDate;
  it('YYYY → Jan 1', () => expect(parse('1973')).toBe('1973-01-01'));
  it('YYYY-MM → day 1', () => expect(parse('1973-06')).toBe('1973-06-01'));
  it('YYYY-MM-DD → unchanged', () => expect(parse('1973-06-15')).toBe('1973-06-15'));
  it('undefined → null', () => expect(parse(undefined)).toBeNull());
  it('garbage → null', () => expect(parse('not-a-date')).toBeNull());
});

describe('computeDuplicateGroups', () => {
  const row = (over: Partial<FamilyRow>): FamilyRow => ({
    uri: 'spotify:track:x',
    isrc: null,
    durationMs: null,
    versionType: 'original',
    duplicateGroupId: null,
    ...over,
  });

  it('singleton family returns no updates', () => {
    const updates = computeDuplicateGroups([row({ uri: 'spotify:track:a' })]);
    expect(updates.size).toBe(0);
  });

  it('singleton with stale group is cleared', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:a', duplicateGroupId: 'spotify:track:old' }),
    ]);
    expect(updates.get('spotify:track:a')).toBeNull();
  });

  it('same ISRC across two URIs → grouped under lex-min URI', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:b', isrc: 'USRC123' }),
      row({ uri: 'spotify:track:a', isrc: 'USRC123' }),
    ]);
    expect(updates.get('spotify:track:a')).toBe('spotify:track:a');
    expect(updates.get('spotify:track:b')).toBe('spotify:track:a');
  });

  it('originals within 1s and no version markers → grouped', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:b', durationMs: 180_500, versionType: 'original' }),
      row({ uri: 'spotify:track:a', durationMs: 180_000, versionType: 'original' }),
    ]);
    expect(updates.get('spotify:track:a')).toBe('spotify:track:a');
    expect(updates.get('spotify:track:b')).toBe('spotify:track:a');
  });

  it('acoustic variant is NOT grouped with the original', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:a', durationMs: 180_000, versionType: 'original' }),
      row({ uri: 'spotify:track:b', durationMs: 180_000, versionType: 'acoustic' }),
    ]);
    // Neither row gets a group (both are solo clusters with no prior group set).
    expect(updates.size).toBe(0);
  });

  it('two originals + one acoustic → only the two originals share a group', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:c', isrc: 'USRC1', versionType: 'original' }),
      row({ uri: 'spotify:track:b', isrc: 'USRC1', versionType: 'original' }),
      row({ uri: 'spotify:track:a', isrc: 'USRC2', versionType: 'acoustic' }),
    ]);
    expect(updates.get('spotify:track:b')).toBe('spotify:track:b');
    expect(updates.get('spotify:track:c')).toBe('spotify:track:b');
    expect(updates.has('spotify:track:a')).toBe(false);
  });

  it('already-correct group → no update emitted (idempotent rerun)', () => {
    const updates = computeDuplicateGroups([
      row({ uri: 'spotify:track:a', isrc: 'USRC1', duplicateGroupId: 'spotify:track:a' }),
      row({ uri: 'spotify:track:b', isrc: 'USRC1', duplicateGroupId: 'spotify:track:a' }),
    ]);
    expect(updates.size).toBe(0);
  });
});

describe('SIMILARS_RATING_THRESHOLD', () => {
  it('matches the 4-star gate', () => {
    expect(__test.SIMILARS_RATING_THRESHOLD).toBe(4);
  });
});
