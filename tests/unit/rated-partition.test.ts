// Shared rated/unrated split used by playlist stats and the unrated-liked
// review list. Rated = URI match OR ISRC match, mirroring the candidate
// loader so picker counts agree with what an "Unrated only" shuffle plays.

import { describe, it, expect } from 'vitest';
import { partitionRated } from '$lib/server/shuffle/rated-partition';

const t = (uri: string, isrc: string | null = null) => ({ uri, isrc, name: uri });

describe('partitionRated', () => {
  it('splits by URI match', () => {
    const out = partitionRated(
      [t('spotify:track:a'), t('spotify:track:b')],
      [{ uri: 'spotify:track:a', isrc: null }],
    );
    expect(out.total).toBe(2);
    expect(out.rated).toBe(1);
    expect(out.unrated.map((x) => x.uri)).toEqual(['spotify:track:b']);
  });

  it('counts an ISRC match as rated even under a different URI', () => {
    const out = partitionRated(
      [t('spotify:track:reissue', 'USRC1')],
      [{ uri: 'spotify:track:original', isrc: 'USRC1' }],
    );
    expect(out.rated).toBe(1);
    expect(out.unrated).toEqual([]);
  });

  it('dedupes repeated URIs before counting', () => {
    const out = partitionRated([t('spotify:track:a'), t('spotify:track:a')], []);
    expect(out.total).toBe(1);
    expect(out.unrated).toHaveLength(1);
  });

  it('null ISRCs never match each other', () => {
    const out = partitionRated([t('spotify:track:b', null)], [
      { uri: 'spotify:track:a', isrc: null },
    ]);
    expect(out.rated).toBe(0);
  });
});
