import { describe, it, expect } from 'vitest';
import {
  defaultSettings,
  normalizeSettings,
  poolSides,
  effectiveSamplerConfig,
  DEFAULT_SAMPLER_CONFIG,
  type ShuffleSettings,
} from '$lib/server/shuffle/config';
import { mergeCandidates } from '$lib/server/shuffle/sources';
import type { PlaylistTrack } from '$lib/server/spotify';

describe('normalizeSettings', () => {
  it('null / garbage → defaults', () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    expect(normalizeSettings('nope')).toEqual(defaultSettings());
    expect(normalizeSettings(42)).toEqual(defaultSettings());
  });

  it('bare SamplerConfig (pre-sources rows) → wrapped with default sources', () => {
    const norm = normalizeSettings(DEFAULT_SAMPLER_CONFIG);
    expect(norm.sources).toEqual({ library: true, playlists: [] });
    expect(norm.sampler).toEqual(DEFAULT_SAMPLER_CONFIG);
  });

  it('full ShuffleSettings round-trips', () => {
    const s: ShuffleSettings = {
      sources: {
        library: false,
        playlists: [{ id: 'pl1', name: 'Imports', mode: 'unrated' }],
      },
      filters: defaultSettings().filters,
      sampler: DEFAULT_SAMPLER_CONFIG,
    };
    expect(normalizeSettings(s)).toEqual(s);
  });

  it('replaces a malformed sampler blob with the default', () => {
    const norm = normalizeSettings({
      sources: { library: true, playlists: [] },
      sampler: {}, // partial sampler from a bad PUT must not persist
    });
    expect(norm.sampler).toEqual(defaultSettings().sampler);
  });

  it('drops malformed playlist entries, keeps valid ones', () => {
    const norm = normalizeSettings({
      sources: {
        library: true,
        playlists: [
          { id: 'ok', name: 'Good', mode: 'both' },
          { id: 42, name: 'bad id', mode: 'both' },
          { id: 'bad-mode', name: 'x', mode: 'shiny' },
          null,
        ],
      },
      sampler: DEFAULT_SAMPLER_CONFIG,
    });
    expect(norm.sources.playlists).toEqual([{ id: 'ok', name: 'Good', mode: 'both' }]);
  });
});

describe('poolSides', () => {
  it('library only → rated allowed+demanded, no unrated', () => {
    expect(poolSides({ library: true, playlists: [] })).toEqual({
      allowsRated: true,
      allowsUnrated: false,
      demandsRated: true,
      demandsUnrated: false,
    });
  });

  it('unrated playlist only → unrated allowed+demanded', () => {
    expect(
      poolSides({ library: false, playlists: [{ id: 'p', name: '', mode: 'unrated' }] }),
    ).toEqual({
      allowsRated: false,
      allowsUnrated: true,
      demandsRated: false,
      demandsUnrated: true,
    });
  });

  it("'both' playlist allows both sides but demands neither", () => {
    expect(
      poolSides({ library: false, playlists: [{ id: 'p', name: '', mode: 'both' }] }),
    ).toEqual({
      allowsRated: true,
      allowsUnrated: true,
      demandsRated: false,
      demandsUnrated: false,
    });
  });
});

describe('effectiveSamplerConfig', () => {
  const settings = defaultSettings(); // mix { rated 100, unrated 0 }, unrated tier 20

  it('rate-walk: unrated-only playlist overrides the stock unratedPct: 0', () => {
    const sides = poolSides({
      library: false,
      playlists: [{ id: 'p', name: '', mode: 'unrated' }],
    });
    const cfg = effectiveSamplerConfig(settings, sides);
    expect(cfg.mix.ratedPct).toBe(0); // nothing rated to draw from
    expect(cfg.mix.unratedPct).toBe(50); // demanded → bumped off 0
  });

  it('library + unrated playlist: both sides live, user rated value kept', () => {
    const sides = poolSides({
      library: true,
      playlists: [{ id: 'p', name: '', mode: 'unrated' }],
    });
    const cfg = effectiveSamplerConfig(settings, sides);
    expect(cfg.mix.ratedPct).toBe(100);
    expect(cfg.mix.unratedPct).toBe(50);
  });

  it("'both' playlist does NOT bump a deliberate unratedPct of 0", () => {
    const sides = poolSides({
      library: true,
      playlists: [{ id: 'p', name: '', mode: 'both' }],
    });
    const cfg = effectiveSamplerConfig(settings, sides);
    expect(cfg.mix.unratedPct).toBe(0); // allowed but not demanded → user value stands
  });

  it('bumps a zero unrated tier weight when unrated is demanded', () => {
    const zeroTier: ShuffleSettings = {
      ...settings,
      sampler: {
        ...settings.sampler,
        tierWeights: { ...settings.sampler.tierWeights, unrated: 0 },
      },
    };
    const sides = poolSides({
      library: false,
      playlists: [{ id: 'p', name: '', mode: 'unrated' }],
    });
    expect(effectiveSamplerConfig(zeroTier, sides).tierWeights.unrated).toBe(20);
  });
});

describe('mergeCandidates', () => {
  const meta = { primaryArtistId: 'a1', genres: ['indie'], versionType: null, explicit: null };
  const pt = (uri: string, artistId = 'sp-artist', isrc: string | null = null): PlaylistTrack => ({
    uri,
    name: uri,
    artists: [{ id: artistId, name: 'Artist' }],
    explicit: false,
    isrc,
  });

  it('unrated mode keeps only tracks without a rating', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [{ mode: 'unrated', tracks: [pt('t:rated'), pt('t:new')] }],
      ratingByUri: new Map([['t:rated', 4]]),
      metaByUri: new Map(),
    });
    expect(out.map((c) => c.uri)).toEqual(['t:new']);
    expect(out[0].tier).toBe('unrated');
    expect(out[0].artistIds).toEqual(['sp-artist']);
  });

  it('rated mode keeps only tracks with a rating, carrying the tier', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [{ mode: 'rated', tracks: [pt('t:rated'), pt('t:new')] }],
      ratingByUri: new Map([['t:rated', 4]]),
      metaByUri: new Map(),
    });
    expect(out.map((c) => c.uri)).toEqual(['t:rated']);
    expect(out[0].tier).toBe('4');
  });

  it('both mode keeps everything', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [{ mode: 'both', tracks: [pt('t:rated'), pt('t:new')] }],
      ratingByUri: new Map([['t:rated', 2]]),
      metaByUri: new Map(),
    });
    expect(out).toHaveLength(2);
  });

  it('dedupes by URI; library entry wins and keeps its metadata', () => {
    const out = mergeCandidates({
      libraryRows: [{ uri: 't:shared', rating: 5, meta }],
      playlists: [{ mode: 'both', tracks: [pt('t:shared'), pt('t:only-pl')] }],
      ratingByUri: new Map([['t:shared', 5]]),
      metaByUri: new Map(),
    });
    expect(out.map((c) => c.uri).sort()).toEqual(['t:only-pl', 't:shared']);
    const shared = out.find((c) => c.uri === 't:shared')!;
    expect(shared.genres).toEqual(['indie']);
    expect(shared.artistIds).toEqual(['a1']);
  });

  it('enriches playlist tracks from the tracks table when known', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [{ mode: 'unrated', tracks: [pt('t:known')] }],
      ratingByUri: new Map(),
      metaByUri: new Map([['t:known', { primaryArtistId: 'a9', genres: ['folk'], versionType: 'live', explicit: null }]]),
    });
    expect(out[0].artistIds).toEqual(['a9']);
    expect(out[0].genres).toEqual(['folk']);
    expect(out[0].versionType).toBe('live');
  });

  it('treats a relinked URI as rated when its ISRC matches a rating', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [
        { mode: 'unrated', tracks: [pt('t:relinked', 'sp-artist', 'USRC1'), pt('t:new')] },
      ],
      ratingByUri: new Map(), // no URI match…
      ratingByIsrc: new Map([['USRC1', 5]]), // …but the recording is rated
      metaByUri: new Map(),
    });
    expect(out.map((c) => c.uri)).toEqual(['t:new']);
  });

  it('dedupes the same track across two playlists', () => {
    const out = mergeCandidates({
      libraryRows: [],
      playlists: [
        { mode: 'unrated', tracks: [pt('t:x')] },
        { mode: 'both', tracks: [pt('t:x')] },
      ],
      ratingByUri: new Map(),
      metaByUri: new Map(),
    });
    expect(out).toHaveLength(1);
  });
});
