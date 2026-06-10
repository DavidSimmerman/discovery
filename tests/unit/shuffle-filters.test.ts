import { describe, it, expect } from 'vitest';
import { applyFilters } from '$lib/server/shuffle/filters';
import {
  defaultFilters,
  normalizeSettings,
  poolSides,
  type ShuffleFilters,
} from '$lib/server/shuffle/config';
import { tierOf, type Candidate } from '$lib/server/shuffle/sampler';

const cand = (over: Partial<Candidate> & { uri: string }): Candidate => ({
  tier: tierOf(over.rating ?? null),
  rating: null,
  artistIds: [],
  genres: [],
  versionType: null,
  explicit: null,
  ...over,
});

const f = (over: Partial<ShuffleFilters> = {}): ShuffleFilters => ({
  ...defaultFilters(),
  ...over,
});

const noLabels = new Map<string, string[]>();

describe('applyFilters — rating', () => {
  const pool = [
    cand({ uri: 't:5', rating: 5 }),
    cand({ uri: 't:3', rating: 3 }),
    cand({ uri: 't:1', rating: 1 }),
    cand({ uri: 't:un' }),
  ];

  it('mode unrated keeps only unrated', () => {
    const out = applyFilters(pool, f({ rating: { mode: 'unrated', minStars: 1, maxStars: 5 } }), noLabels);
    expect(out.map((c) => c.uri)).toEqual(['t:un']);
  });

  it('mode rated keeps only rated, range applies', () => {
    const out = applyFilters(pool, f({ rating: { mode: 'rated', minStars: 3, maxStars: 5 } }), noLabels);
    expect(out.map((c) => c.uri)).toEqual(['t:5', 't:3']);
  });

  it('mode both: range trims rated, unrated passes', () => {
    const out = applyFilters(pool, f({ rating: { mode: 'both', minStars: 4, maxStars: 5 } }), noLabels);
    expect(out.map((c) => c.uri)).toEqual(['t:5', 't:un']);
  });
});

describe('applyFilters — axes', () => {
  it('artist exclude wins over include', () => {
    const pool = [cand({ uri: 't:a', artistIds: ['a1'] }), cand({ uri: 't:b', artistIds: ['a2'] })];
    const out = applyFilters(
      pool,
      f({
        artists: {
          include: [{ id: 'a1', name: 'A' }, { id: 'a2', name: 'B' }],
          exclude: [{ id: 'a1', name: 'A' }],
        },
      }),
      noLabels,
    );
    expect(out.map((c) => c.uri)).toEqual(['t:b']);
  });

  it('include-only restricts the axis; valueless tracks drop when includes set', () => {
    const pool = [
      cand({ uri: 't:indie', genres: ['indie rock'] }),
      cand({ uri: 't:pop', genres: ['pop'] }),
      cand({ uri: 't:none', genres: [] }),
    ];
    const out = applyFilters(
      pool,
      f({ genres: { include: [{ id: 'indie rock', name: 'indie rock' }], exclude: [] } }),
      noLabels,
    );
    expect(out.map((c) => c.uri)).toEqual(['t:indie']);
  });

  it('label include/exclude via the per-uri map', () => {
    const pool = [cand({ uri: 't:deep' }), cand({ uri: 't:skip' }), cand({ uri: 't:plain' })];
    const labels = new Map([
      ['t:deep', ['l-deep']],
      ['t:skip', ['l-deep', 'l-skip']],
    ]);
    const out = applyFilters(
      pool,
      f({
        labels: {
          include: [{ id: 'l-deep', name: 'deep cut' }],
          exclude: [{ id: 'l-skip', name: 'skip' }],
        },
      }),
      labels,
    );
    expect(out.map((c) => c.uri)).toEqual(['t:deep']);
  });

  it('version excludes drop matches, keep null/undetected', () => {
    const pool = [
      cand({ uri: 't:live', versionType: 'live' }),
      cand({ uri: 't:orig', versionType: 'original' }),
      cand({ uri: 't:unk' }),
    ];
    const out = applyFilters(pool, f({ versionTypes: { exclude: ['live'] } }), noLabels);
    expect(out.map((c) => c.uri)).toEqual(['t:orig', 't:unk']);
  });

  it('explicit off drops known-explicit, keeps unknown', () => {
    const pool = [
      cand({ uri: 't:exp', explicit: true }),
      cand({ uri: 't:clean', explicit: false }),
      cand({ uri: 't:unk', explicit: null }),
    ];
    const out = applyFilters(pool, f({ allowExplicit: false }), noLabels);
    expect(out.map((c) => c.uri)).toEqual(['t:clean', 't:unk']);
  });
});

describe('filters in normalizeSettings', () => {
  it('missing filters → defaults (older v1 rows)', () => {
    const norm = normalizeSettings({
      sources: { library: true, playlists: [] },
      sampler: defaultSettingsSampler(),
    });
    expect(norm.filters).toEqual(defaultFilters());
  });

  it('malformed filter fields fold to defaults per-field', () => {
    const norm = normalizeSettings({
      sources: { library: true, playlists: [] },
      filters: {
        rating: { mode: 'shiny', minStars: 9, maxStars: 'x' },
        artists: { include: [{ id: 'a1', name: 'A' }, { id: 42 }], exclude: 'nope' },
        allowExplicit: 'yes',
      },
      sampler: defaultSettingsSampler(),
    });
    expect(norm.filters.rating).toEqual({ mode: 'both', minStars: 5, maxStars: 5 });
    expect(norm.filters.artists).toEqual({ include: [{ id: 'a1', name: 'A' }], exclude: [] });
    expect(norm.filters.allowExplicit).toBe(true);
  });
});

describe('poolSides with rating filter mode', () => {
  it("mode 'unrated' kills the rated side and demands unrated when available", () => {
    const sides = poolSides(
      { library: true, playlists: [{ id: 'p', name: '', mode: 'both' }] },
      'unrated',
    );
    expect(sides).toEqual({
      allowsRated: false,
      allowsUnrated: true,
      demandsRated: false,
      demandsUnrated: true,
    });
  });

  it("mode 'rated' kills the unrated side", () => {
    const sides = poolSides(
      { library: false, playlists: [{ id: 'p', name: '', mode: 'unrated' }] },
      'rated',
    );
    expect(sides.allowsUnrated).toBe(false);
    expect(sides.demandsUnrated).toBe(false);
    expect(sides.allowsRated).toBe(false); // nothing rated on offer either
  });
});

function defaultSettingsSampler() {
  // minimal valid sampler blob (mirrors DEFAULT_SAMPLER_CONFIG's shape checks)
  return {
    mix: { ratedPct: 100, unratedPct: 0 },
    tierWeights: { '1': 0, '2': 10, '3': 30, '4': 70, '5': 100, unrated: 20 },
    filters: {},
    gates: {
      cooldownCount: { enabled: true, n: 50 },
      cooldownTime: { enabled: true, hours: 6 },
      dailyCap: { enabled: false, max: 2 },
    },
    recency: {
      '5': { curve: 'log', halfLifePicks: 80 },
      '4': { curve: 'exp', halfLifePicks: 40 },
      '3': { curve: 'linear', halfLifePicks: 20 },
      '2': { curve: 'linear', halfLifePicks: 10 },
      '1': { curve: 'linear', halfLifePicks: 5 },
      unrated: { curve: 'linear', halfLifePicks: 20 },
    },
  };
}
