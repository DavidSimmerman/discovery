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

export type ShuffleSettings = {
  sources: ShuffleSources;
  sampler: SamplerConfig;
};

export const DEFAULT_SAMPLER_CONFIG: SamplerConfig = {
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

export function defaultSettings(): ShuffleSettings {
  return {
    sources: { library: true, playlists: [] },
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
    return { sources: { library: true, playlists: [] }, sampler: obj as SamplerConfig };
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
    sampler: isSamplerConfig(obj.sampler) ? obj.sampler : def.sampler,
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

export function poolSides(sources: ShuffleSources): PoolSides {
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
  // Same guard for the unrated tier weight — a demanded unrated source must be
  // playable even though the default weight table zeroes/de-prioritizes unrated.
  const tierWeights =
    sides.demandsUnrated && s.tierWeights.unrated === 0
      ? { ...s.tierWeights, unrated: 20 }
      : s.tierWeights;
  return { ...s, mix, tierWeights };
}
