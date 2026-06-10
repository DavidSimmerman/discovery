import { describe, it, expect } from 'vitest';
import {
  pickNext,
  baseScore,
  recencyMultiplier,
  gateOk,
  weightedSample,
  applyMixSplit,
  type Candidate,
  type SamplerConfig,
  type SamplerState,
  type RatingTier,
} from '$lib/server/shuffle/sampler';

// Tiny deterministic RNG (mulberry32) so weighted-sample tests are reproducible.
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = new Date('2026-05-27T12:00:00Z').getTime();

function emptyState(overrides: Partial<SamplerState> = {}): SamplerState {
  return {
    recentlyPlayed: [],
    recentlyPlayedAt: {},
    dailyPlayCounts: {},
    dailyResetAt: NOW,
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<SamplerConfig> = {}): SamplerConfig {
  return {
    mix: { ratedPct: 50, unratedPct: 50 },
    tierWeights: { '1': 0, '2': 10, '3': 30, '4': 70, '5': 100, unrated: 20 },
    filters: {},
    gates: {
      cooldownCount: { enabled: true, n: 5 },
      cooldownTime: { enabled: true, hours: 6 },
      dailyCap: { enabled: false, max: 2 },
    },
    recency: {
      '5': { curve: 'log', halfLifePicks: 10 },
      '4': { curve: 'exp', halfLifePicks: 5 },
      '3': { curve: 'linear', halfLifePicks: 5 },
      '2': { curve: 'linear', halfLifePicks: 5 },
      '1': { curve: 'linear', halfLifePicks: 5 },
      unrated: { curve: 'linear', halfLifePicks: 5 },
    },
    ...overrides,
  };
}

function cand(uri: string, tier: RatingTier, extra: Partial<Candidate> = {}): Candidate {
  return {
    uri,
    tier,
    rating: tier === 'unrated' ? null : Number(tier),
    artistIds: [],
    genres: [],
    versionType: null,
    ...extra,
  };
}

describe('gateOk', () => {
  it('excludes URIs inside the count cooldown window', () => {
    const c = cand('spotify:track:a', '4');
    const state = emptyState({
      recentlyPlayed: ['spotify:track:a', 'spotify:track:b'],
    });
    expect(gateOk(c, state, defaultConfig(), NOW)).toBe(false);
  });

  it('allows URIs outside the count cooldown window', () => {
    const c = cand('spotify:track:a', '4');
    // 6 entries, newest first; cooldownCount.n=5 gates indices 0..4.
    // 'spotify:track:a' sits at index 5 (just outside) so it's eligible.
    const state = emptyState({
      recentlyPlayed: ['e', 'd', 'c', 'b', 'a', 'spotify:track:a'],
    });
    expect(gateOk(c, state, defaultConfig(), NOW)).toBe(true);
  });

  it('excludes URIs played within the time cooldown', () => {
    const c = cand('spotify:track:a', '4');
    const twoHoursAgo = NOW - 2 * 60 * 60 * 1000;
    const state = emptyState({ recentlyPlayedAt: { 'spotify:track:a': twoHoursAgo } });
    expect(gateOk(c, state, defaultConfig(), NOW)).toBe(false);
  });

  it('allows URIs past the time cooldown', () => {
    const c = cand('spotify:track:a', '4');
    const sevenHoursAgo = NOW - 7 * 60 * 60 * 1000;
    const state = emptyState({ recentlyPlayedAt: { 'spotify:track:a': sevenHoursAgo } });
    expect(gateOk(c, state, defaultConfig(), NOW)).toBe(true);
  });

  it('respects daily cap when enabled', () => {
    const c = cand('spotify:track:a', '4');
    const cfg = defaultConfig({
      gates: {
        cooldownCount: { enabled: false, n: 5 },
        cooldownTime: { enabled: false, hours: 6 },
        dailyCap: { enabled: true, max: 2 },
      },
    });
    const state = emptyState({ dailyPlayCounts: { 'spotify:track:a': 2 } });
    expect(gateOk(c, state, cfg, NOW)).toBe(false);
  });

  it('excludes when tier weight is 0', () => {
    const c = cand('spotify:track:a', '1');
    expect(gateOk(c, emptyState(), defaultConfig(), NOW)).toBe(false);
  });
});

describe('baseScore', () => {
  it('multiplies tier weight by mix multiplier for rated tracks', () => {
    const c = cand('a', '5');
    const cfg = defaultConfig({ mix: { ratedPct: 100, unratedPct: 0 } });
    // tier 5 weight = 100, mix mult for rated = 100/50 = 2 → 200
    expect(baseScore(c, cfg)).toBe(200);
  });

  it('downweights unrated when mix favors rated', () => {
    const c = cand('a', 'unrated');
    const cfg = defaultConfig({ mix: { ratedPct: 100, unratedPct: 0 } });
    expect(baseScore(c, cfg)).toBe(0);
  });

  it('treats neutral slider (50) as 1.0', () => {
    const c = cand('a', '5', { versionType: 'original' });
    const cfg = defaultConfig({ filters: { versionTypes: { original: 50 } } });
    // tier=100, version slider=50 → 1.0x, mix=50 → 1.0x → 100
    expect(baseScore(c, cfg)).toBe(100);
  });

  it('excludes when a filter slider is 0 (via baseScore returning 0)', () => {
    const c = cand('a', '5', { versionType: 'remix' });
    const cfg = defaultConfig({ filters: { versionTypes: { remix: 0 } } });
    expect(baseScore(c, cfg)).toBe(0);
  });

  it('boosts when an artist slider is above neutral', () => {
    const neutral = baseScore(cand('a', '5', { artistIds: ['art1'] }), defaultConfig());
    const boosted = baseScore(
      cand('a', '5', { artistIds: ['art1'] }),
      defaultConfig({ filters: { artists: { art1: 100 } } }),
    );
    expect(boosted).toBeCloseTo(neutral * 2, 5);
  });

  it('penalizes when a genre slider is below neutral', () => {
    const neutral = baseScore(cand('a', '5', { genres: ['indie'] }), defaultConfig());
    const dampened = baseScore(
      cand('a', '5', { genres: ['indie'] }),
      defaultConfig({ filters: { genres: { indie: 25 } } }),
    );
    expect(dampened).toBeCloseTo(neutral * 0.5, 5);
  });

  it('boosts when a label slider is above neutral', () => {
    const neutral = baseScore(cand('a', '5', { labels: ['lbl1'] }), defaultConfig());
    const boosted = baseScore(
      cand('a', '5', { labels: ['lbl1'] }),
      defaultConfig({ filters: { labels: { lbl1: 100 } } }),
    );
    expect(boosted).toBeCloseTo(neutral * 2, 5);
  });

  it('excludes when a label slider is 0', () => {
    const cfg = defaultConfig({ filters: { labels: { lbl1: 0 } } });
    expect(baseScore(cand('a', '5', { labels: ['lbl1'] }), cfg)).toBe(0);
    expect(gateOk(cand('a', '5', { labels: ['lbl1'] }), emptyState(), cfg, NOW)).toBe(false);
  });

  it('leaves candidates without the configured label untouched', () => {
    const cfg = defaultConfig({ filters: { labels: { lbl1: 100 } } });
    const neutral = baseScore(cand('a', '5'), defaultConfig());
    expect(baseScore(cand('a', '5', { labels: ['other'] }), cfg)).toBe(neutral);
    expect(baseScore(cand('a', '5'), cfg)).toBe(neutral);
  });
});

describe('discovery slot', () => {
  // rng stub yielding a fixed sequence (slot roll first, then weighted sample).
  const seq = (...vals: number[]) => {
    let i = 0;
    return () => vals[Math.min(i++, vals.length - 1)];
  };
  const disc = (uri: string, match = 1) =>
    cand(uri, 'unrated', { discovery: true, matchScore: match });

  it('picks a discovery track when the slot roll lands under pct', () => {
    const result = pickNext({
      candidates: [cand('r', '5'), disc('d')],
      state: emptyState(),
      config: defaultConfig({ discovery: { pct: 10 } }),
      now: NOW,
      rng: seq(0.05, 0.5), // roll 5 < 10 → discovery slot
    });
    expect(result.uri).toBe('d');
    expect(result.debug?.slot).toBe('discovery');
  });

  it('picks from the regular pool when the roll lands above pct', () => {
    const result = pickNext({
      candidates: [cand('r', '5'), disc('d')],
      state: emptyState(),
      config: defaultConfig({ discovery: { pct: 10 } }),
      now: NOW,
      rng: seq(0.5, 0.5), // roll 50 ≥ 10 → regular
    });
    expect(result.uri).toBe('r');
    expect(result.debug?.slot).toBe('regular');
  });

  it('never plays discovery candidates when pct is 0 or unset', () => {
    for (const config of [defaultConfig({ discovery: { pct: 0 } }), defaultConfig()]) {
      const result = pickNext({
        candidates: [disc('d')],
        state: emptyState(),
        config,
        now: NOW,
        rng: seq(0.0),
      });
      expect(result.uri).toBeNull();
    }
  });

  it('ignores the rated/unrated mix and unrated tier weight (the dial is authoritative)', () => {
    const result = pickNext({
      candidates: [disc('d')],
      state: emptyState(),
      config: defaultConfig({
        discovery: { pct: 100 },
        mix: { ratedPct: 100, unratedPct: 0 },
        tierWeights: { '1': 0, '2': 10, '3': 30, '4': 70, '5': 100, unrated: 0 },
      }),
      now: NOW,
      rng: seq(0.5, 0.5),
    });
    expect(result.uri).toBe('d');
  });

  it('falls back to discovery when the regular pool is empty, even above pct', () => {
    const result = pickNext({
      candidates: [disc('d')],
      state: emptyState(),
      config: defaultConfig({ discovery: { pct: 10 } }),
      now: NOW,
      rng: seq(0.99, 0.5),
    });
    expect(result.uri).toBe('d');
    expect(result.debug?.slot).toBe('discovery');
  });

  it('falls back to the regular pool when every discovery track is cooling down', () => {
    const result = pickNext({
      candidates: [cand('r', '5'), disc('d')],
      state: emptyState({
        recentlyPlayed: ['d'],
        recentlyPlayedAt: { d: NOW - 1000 },
      }),
      config: defaultConfig({ discovery: { pct: 100 } }),
      now: NOW,
      rng: seq(0.0, 0.5),
    });
    expect(result.uri).toBe('r');
    expect(result.debug?.slot).toBe('regular');
  });

  it('weights the discovery sample by match score', () => {
    // strong=0.9 vs weak=0.1 → cumulative weighted sample: a draw of 0.5
    // (× total 1.0) lands inside the strong track's 0.9 span.
    const result = pickNext({
      candidates: [disc('strong', 0.9), disc('weak', 0.1)],
      state: emptyState(),
      config: defaultConfig({ discovery: { pct: 100 } }),
      now: NOW,
      rng: seq(0.0, 0.5),
    });
    expect(result.uri).toBe('strong');
  });
});

describe('recencyMultiplier', () => {
  it('returns 1 for never-played candidates', () => {
    const c = cand('a', '5');
    expect(recencyMultiplier(c, emptyState(), defaultConfig())).toBe(1);
  });

  it('dampens recently played candidates below 1', () => {
    const c = cand('a', '5');
    // 'a' is the most recent pick — picksAgo = 0
    const state = emptyState({ recentlyPlayed: ['a'] });
    expect(recencyMultiplier(c, state, defaultConfig())).toBeLessThan(0.5);
  });

  it('approaches 1 as picks accumulate', () => {
    const c = cand('a', '5');
    // Newest first: 50 'x' entries then 'a' → picksAgo('a') = 50. log curve, hl=10.
    const recents = Array(50).fill('x').concat(['a']);
    const state = emptyState({ recentlyPlayed: recents });
    expect(recencyMultiplier(c, state, defaultConfig())).toBeGreaterThan(0.9);
  });
});

describe('weightedSample', () => {
  it('is deterministic with a seeded RNG', () => {
    const items = [
      { uri: 'a', weight: 1 },
      { uri: 'b', weight: 1 },
      { uri: 'c', weight: 1 },
    ];
    const r1 = weightedSample(items, rng(42));
    const r2 = weightedSample(items, rng(42));
    expect(r1).toBe(r2);
  });

  it('skews toward high-weight items', () => {
    const items = [
      { uri: 'low', weight: 1 },
      { uri: 'high', weight: 99 },
    ];
    const r = rng(7);
    let highHits = 0;
    for (let i = 0; i < 1000; i++) if (weightedSample(items, r) === 'high') highHits++;
    expect(highHits).toBeGreaterThan(900);
  });

  it('returns null on empty input', () => {
    expect(weightedSample([], rng(1))).toBeNull();
  });

  it('returns null when all weights are zero', () => {
    expect(weightedSample([{ uri: 'a', weight: 0 }], rng(1))).toBeNull();
  });
});

describe('applyMixSplit', () => {
  it('drops rated candidates when mix is 0/100', () => {
    const pool = [cand('a', '5'), cand('b', 'unrated')];
    const cfg = defaultConfig({ mix: { ratedPct: 0, unratedPct: 100 } });
    const out = applyMixSplit(pool, cfg);
    expect(out.map((c) => c.uri)).toEqual(['b']);
  });

  it('keeps both when mix is balanced', () => {
    const pool = [cand('a', '5'), cand('b', 'unrated')];
    const out = applyMixSplit(pool, defaultConfig());
    expect(out).toHaveLength(2);
  });
});

describe('pickNext (integration)', () => {
  it('picks a high-tier candidate over a low-tier one', () => {
    const pool = [cand('low', '2'), cand('high', '5')];
    const result = pickNext({
      candidates: pool,
      state: emptyState(),
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).toBe('high');
  });

  it('avoids URIs inside the cooldown window', () => {
    const pool = [cand('recent', '5'), cand('fresh', '5')];
    const state = emptyState({ recentlyPlayed: ['recent'] });
    const result = pickNext({
      candidates: pool,
      state,
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).toBe('fresh');
  });

  it('relaxes cooldowns rather than stalling on a fully-cooled small library', () => {
    // Library smaller than the cooldown window: all tracks are inside it, so
    // strict gating would return null. Relaxation must keep music playing.
    const pool = [cand('only', '5')];
    const state = emptyState({
      recentlyPlayed: ['only'],
      recentlyPlayedAt: { only: NOW - 60_000 }, // 1 min ago, inside 6h time cooldown too
    });
    const result = pickNext({
      candidates: pool,
      state,
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).toBe('only');
    expect(result.debug?.relaxed).toBe('drop_cooldowns');
  });

  it('prefers the least-recently-played track when relaxing', () => {
    // Both inside the cooldown window; 'older' was played longer ago, so once
    // cooldowns relax, recency damping should still favor it over 'newer'.
    const pool = [cand('newer', '5'), cand('older', '5')];
    const state = emptyState({
      recentlyPlayed: ['newer', 'older'], // newer is index 0 (most recent)
    });
    const result = pickNext({
      candidates: pool,
      state,
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).toBe('older');
    expect(result.debug?.relaxed).not.toBe('none');
  });

  it('still returns null when weight=0 filters exclude everything', () => {
    // Relaxation drops cooldowns, not intentional excludes. A library of only
    // tier-1 tracks (weight 0) stays empty — that is the user's explicit filter.
    const pool = [cand('a', '1'), cand('b', '1')];
    const result = pickNext({
      candidates: pool,
      state: emptyState(),
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).toBeNull();
  });

  it('reports relaxed: none on a healthy pick', () => {
    const pool = [cand('a', '5'), cand('b', '4')];
    const result = pickNext({
      candidates: pool,
      state: emptyState(),
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.debug?.relaxed).toBe('none');
  });

  it('produces debug scores on the returned candidate', () => {
    const pool = [cand('a', '5'), cand('b', '4')];
    const result = pickNext({
      candidates: pool,
      state: emptyState(),
      config: defaultConfig(),
      now: NOW,
      rng: rng(1),
    });
    expect(result.uri).not.toBeNull();
    expect(result.debug).toBeDefined();
    expect(result.debug?.poolSize).toBe(2);
    expect(result.debug?.eligibleSize).toBe(2);
    expect(result.debug?.winnerScore).toBeGreaterThan(0);
  });
});
