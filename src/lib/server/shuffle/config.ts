// Per-user shuffle settings: which pools feed the sampler (sources) plus the
// sampler knobs themselves. Persisted in shuffleSessions.activeConfig.
//
// Older rows stored a bare SamplerConfig there; normalizeSettings() folds those
// forward, so no migration is needed.

import type { SamplerConfig } from './sampler';

// Which of a playlist's tracks the source contributes, judged against the
// user's ratings table: 'unrated' = tracks they haven't rated yet (the
// rate-walk mode), 'rated' = only tracks they have, 'both' = everything.
export type PlaylistSourceMode = 'unrated' | 'rated' | 'both';

export type PlaylistSource = {
  id: string;
  // Display-only snapshot of the playlist name at selection time; the picker
  // refreshes it whenever the user reopens settings.
  name: string;
  mode: PlaylistSourceMode;
};

export type ShuffleSources = {
  // The user's rated discovery library (current default pool).
  library: boolean;
  playlists: PlaylistSource[];
};

// Hard include/exclude filters, applied as a candidate pre-filter (see
// shuffle/filters.ts) — distinct from the sampler's soft 0–100 weighting.
// include non-empty = "only these"; exclude always wins over include.
// Entries carry display names so the settings UI doesn't need a lookup.
export type FilterEntry = { id: string; name: string };

export type RatingFilterMode = 'unrated' | 'rated' | 'both';

export type ShuffleFilters = {
  rating: {
    mode: RatingFilterMode;
    // Star range, applied to RATED candidates only (1..5, inclusive).
    minStars: number;
    maxStars: number;
  };
  artists: { include: FilterEntry[]; exclude: FilterEntry[] };
  genres: { include: FilterEntry[]; exclude: FilterEntry[] };
  labels: { include: FilterEntry[]; exclude: FilterEntry[] };
  versionTypes: { exclude: string[] };
  allowExplicit: boolean;
};

export type ShuffleSettings = {
  sources: ShuffleSources;
  filters: ShuffleFilters;
  sampler: SamplerConfig;
};

// Moved to $lib/shuffle/defaults so the settings UI can import it (Reset);
// re-exported here so server code keeps its one import site.
export { DEFAULT_SAMPLER_CONFIG } from '$lib/shuffle/defaults';
import { DEFAULT_SAMPLER_CONFIG } from '$lib/shuffle/defaults';

export function defaultFilters(): ShuffleFilters {
  return {
    rating: { mode: 'both', minStars: 1, maxStars: 5 },
    artists: { include: [], exclude: [] },
    genres: { include: [], exclude: [] },
    labels: { include: [], exclude: [] },
    versionTypes: { exclude: [] },
    allowExplicit: true,
  };
}

export function defaultSettings(): ShuffleSettings {
  return {
    sources: { library: true, playlists: [] },
    filters: defaultFilters(),
    sampler: structuredClone(DEFAULT_SAMPLER_CONFIG),
  };
}

// Fold whatever is persisted in activeConfig into the current shape.
// Three generations of blob exist: null/garbage → defaults; a bare
// SamplerConfig (rows written before sources existed) → wrap with the default
// sources; the full ShuffleSettings → as-is, with missing fields defaulted.
export function normalizeSettings(raw: unknown): ShuffleSettings {
  if (raw == null || typeof raw !== 'object') return defaultSettings();
  const obj = raw as Record<string, unknown>;

  // Bare SamplerConfig: has sampler fields at the top level, no `sources`.
  if (!('sources' in obj) && 'mix' in obj && 'tierWeights' in obj) {
    return {
      sources: { library: true, playlists: [] },
      filters: defaultFilters(),
      sampler: obj as SamplerConfig,
    };
  }

  const def = defaultSettings();
  const sources = (obj.sources ?? {}) as Partial<ShuffleSources>;
  const playlists = Array.isArray(sources.playlists)
    ? sources.playlists.filter(
        (p): p is PlaylistSource =>
          p != null &&
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          (p.mode === 'unrated' || p.mode === 'rated' || p.mode === 'both'),
      )
    : [];
  return {
    sources: {
      library: typeof sources.library === 'boolean' ? sources.library : def.sources.library,
      playlists,
    },
    filters: normalizeFilters(obj.filters),
    sampler: isSamplerConfig(obj.sampler) ? obj.sampler : def.sampler,
  };
}

// Per-field fold of a persisted/PUT filters blob — anything malformed drops to
// its default rather than rejecting the whole settings object (same philosophy
// as the playlists fold above: the stored blob must always be loadable).
function normalizeFilters(raw: unknown): ShuffleFilters {
  const def = defaultFilters();
  if (raw == null || typeof raw !== 'object') return def;
  const f = raw as Record<string, unknown>;

  const entryList = (v: unknown): FilterEntry[] =>
    Array.isArray(v)
      ? v.filter(
          (e): e is FilterEntry =>
            e != null && typeof e.id === 'string' && typeof e.name === 'string',
        )
      : [];
  const axis = (v: unknown): { include: FilterEntry[]; exclude: FilterEntry[] } => {
    const a = (v ?? {}) as Record<string, unknown>;
    return { include: entryList(a.include), exclude: entryList(a.exclude) };
  };
  const clampStars = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isInteger(v) ? Math.max(1, Math.min(5, v)) : fallback;

  const rating = (f.rating ?? {}) as Record<string, unknown>;
  const mode: RatingFilterMode =
    rating.mode === 'unrated' || rating.mode === 'rated' || rating.mode === 'both'
      ? rating.mode
      : def.rating.mode;
  const minStars = clampStars(rating.minStars, def.rating.minStars);
  const maxStars = clampStars(rating.maxStars, def.rating.maxStars);

  const versionTypes = (f.versionTypes ?? {}) as Record<string, unknown>;

  return {
    rating: { mode, minStars: Math.min(minStars, maxStars), maxStars },
    artists: axis(f.artists),
    genres: axis(f.genres),
    labels: axis(f.labels),
    versionTypes: {
      exclude: Array.isArray(versionTypes.exclude)
        ? versionTypes.exclude.filter((v): v is string => typeof v === 'string')
        : [],
    },
    allowExplicit: typeof f.allowExplicit === 'boolean' ? f.allowExplicit : def.allowExplicit,
  };
}

// Structural check before persisting/using a sampler blob — a partial sampler
// (e.g. {} from a bad PUT) would otherwise crash every later shuffle on
// `s.mix.ratedPct`. Spot-checks one leaf per top-level field; deeper damage
// degrades gracefully (sampler code falls back per-field).
function isSamplerConfig(raw: unknown): raw is SamplerConfig {
  if (raw == null || typeof raw !== 'object') return false;
  const s = raw as Partial<SamplerConfig>;
  return (
    typeof s.mix?.ratedPct === 'number' &&
    typeof s.mix?.unratedPct === 'number' &&
    s.tierWeights != null &&
    typeof s.tierWeights['unrated'] === 'number' &&
    typeof s.gates?.cooldownCount?.enabled === 'boolean' &&
    s.recency != null &&
    typeof s.recency['unrated']?.halfLifePicks === 'number'
  );
}

// What the configured sources say about rated vs. unrated, by mode alone:
// - allows: the side can appear in the pool at all
// - demands: the user explicitly asked for that side (library is rated by
//   definition; a playlist in 'unrated'/'rated' mode is an explicit ask).
//   'both' allows both sides but demands neither.
export type PoolSides = {
  allowsRated: boolean;
  allowsUnrated: boolean;
  demandsRated: boolean;
  demandsUnrated: boolean;
};

// The global rating FILTER narrows what the sources offer: filtering to
// "unrated" makes the surviving pool entirely unrated — and that's an explicit
// ask, so the unrated side is demanded (and vice versa). Without folding the
// filter in here, the stock mix (unratedPct: 0) would zero out a pool the user
// filtered to unrated on purpose.
export function poolSides(sources: ShuffleSources, ratingMode: RatingFilterMode = 'both'): PoolSides {
  const sides: PoolSides = {
    allowsRated: sources.library,
    allowsUnrated: false,
    demandsRated: sources.library,
    demandsUnrated: false,
  };
  for (const p of sources.playlists) {
    if (p.mode === 'rated') {
      sides.allowsRated = sides.demandsRated = true;
    } else if (p.mode === 'unrated') {
      sides.allowsUnrated = sides.demandsUnrated = true;
    } else {
      sides.allowsRated = sides.allowsUnrated = true;
    }
  }
  if (ratingMode === 'unrated') {
    sides.allowsRated = sides.demandsRated = false;
    if (sides.allowsUnrated) sides.demandsUnrated = true;
  } else if (ratingMode === 'rated') {
    sides.allowsUnrated = sides.demandsUnrated = false;
    if (sides.allowsRated) sides.demandsRated = true;
  }
  return sides;
}

// Source modes are authoritative over the sampler's rated/unrated mix:
// - A side no source allows is forced to 0 (nothing to draw from).
// - A side the user explicitly demanded must not be zeroed out by a stale
//   mix value (the stock default is unratedPct: 0, which would silently
//   exclude an "Unrated only" playlist). A demanded-but-zero side is bumped
//   to 50 — a real share, since the user asked for those tracks by name.
// - Otherwise the user's mix value stands.
export function effectiveSamplerConfig(settings: ShuffleSettings, sides: PoolSides): SamplerConfig {
  const s = settings.sampler;
  const bump = (allowed: boolean, demanded: boolean, value: number): number => {
    if (!allowed) return 0;
    if (demanded && value === 0) return 50;
    return value;
  };
  const mix = {
    ratedPct: bump(sides.allowsRated, sides.demandsRated, s.mix.ratedPct),
    unratedPct: bump(sides.allowsUnrated, sides.demandsUnrated, s.mix.unratedPct),
  };
  // The unrated TIER weight is deliberately not bumped: unlike mix.unratedPct
  // (whose stock value is 0, so a zero usually just means "never touched"),
  // every shipped default has unrated tier weight 20 — a 0 there can only be
  // the user dragging the Weighting bar to "never", which we honor.
  return { ...s, mix };
}
