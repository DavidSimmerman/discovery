import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  searchTrack: vi.fn(),
  idFromUri: (u: string) => u,
}));

import {
  autoEnrichIfBehind,
  computeDuplicateGroups,
  __test,
  type FamilyRow,
} from '../../src/lib/server/shuffle/enrichment';

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

describe('autoEnrichIfBehind', () => {
  const T0 = 1_700_000_000_000;

  function deps(over: Partial<Parameters<typeof autoEnrichIfBehind>[2]> = {}) {
    return {
      backlogProbe: vi.fn(async () => ['spotify:track:x']),
      token: vi.fn(async () => ({ access_token: 'tok' })),
      run: vi.fn(async () => ({ processed: 1, failed: 0 })),
      ...over,
    };
  }

  beforeEach(() => __test.resetAutoEnrichState());

  it('kicks a run when there is a backlog', async () => {
    const d = deps();
    await expect(autoEnrichIfBehind('u1', T0, d)).resolves.toBe(true);
    expect(d.run).toHaveBeenCalledWith('u1', 'tok');
  });

  it('does nothing when fully enriched', async () => {
    const d = deps({ backlogProbe: vi.fn(async () => []) });
    await expect(autoEnrichIfBehind('u1', T0, d)).resolves.toBe(false);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('debounces within the cooldown window, per user', async () => {
    const d = deps();
    await autoEnrichIfBehind('u1', T0, d);
    await expect(autoEnrichIfBehind('u1', T0 + 60_000, d)).resolves.toBe(false);
    await expect(autoEnrichIfBehind('u2', T0 + 60_000, d)).resolves.toBe(true);
    expect(d.run).toHaveBeenCalledTimes(2);
  });

  it('kicks again after the cooldown expires', async () => {
    const d = deps();
    await autoEnrichIfBehind('u1', T0, d);
    await expect(autoEnrichIfBehind('u1', T0 + 6 * 60_000, d)).resolves.toBe(true);
    expect(d.run).toHaveBeenCalledTimes(2);
  });

  it('never throws — token failures are swallowed', async () => {
    const d = deps({ token: vi.fn(async () => Promise.reject(new Error('no token'))) });
    await expect(autoEnrichIfBehind('u1', T0, d)).resolves.toBe(false);
  });

  it('swallows a rejected run (fire-and-forget)', async () => {
    const d = deps({ run: vi.fn(async () => Promise.reject(new Error('boom'))) });
    await expect(autoEnrichIfBehind('u1', T0, d)).resolves.toBe(true);
    await new Promise((r) => setImmediate(r)); // let the rejection settle
  });
});
