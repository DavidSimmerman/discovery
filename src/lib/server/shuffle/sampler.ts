// Shuffle sampler — core pick pipeline. Pure functions over inputs the caller
// supplies (candidates, ratings, recent plays, current state). The HTTP layer
// loads inputs from Postgres, calls pickNext, and writes the resulting state +
// play row back. Keeping this file dependency-free makes it trivial to unit-test.
//
// This is the v1 subset of the design in
// ~/dev/disccovery-superpowers/specs/shuffle-sampler.md — pool/mix, gates
// (count + time cooldown, daily cap, weight=0 filters), base scoring (tier ×
// per-axis filter × mix), per-tier recency, weighted sample, state update.
// Skipped for now: coherence, streaks, arc, loop slots, dup-rotation,
// progressive relaxation, family inheritance, ai_boost. They'll layer in.
//
// Ratings are 1..5 whole stars (current DB shape). Tier keys are stringified
// for stable JSON config + the 'unrated' sentinel.

export type RatingTier = '1' | '2' | '3' | '4' | '5' | 'unrated';

export type Candidate = {
  uri: string;
  tier: RatingTier;
  // null only when tier === 'unrated'
  rating: number | null;
  artistIds: string[];
  genres: string[];
  // 'original' | 'acoustic' | 'live' | 'remix' | ... | null when undetected
  versionType: string | null;
  // null when unknown (track not yet enriched). Consumed by the hard filter
  // layer (shuffle/filters.ts), not by the sampler itself.
  explicit?: boolean | null;
};

export type SamplerState = {
  // Newest first. Bounded by max cooldownCount.n the caller cares about.
  recentlyPlayed: string[];
  // Last-played epoch ms keyed by URI. Drives the hours cooldown + recency curve.
  recentlyPlayedAt: Record<string, number>;
  // Play count since dailyResetAt. Reset by the caller at user-local midnight.
  dailyPlayCounts: Record<string, number>;
  dailyResetAt: number;
};

// What we actually persist in shuffleSessions.state. The sampler logic only
// touches SamplerState; the virtual playback timeline lives alongside it so
// load/save is one DB round-trip. The timeline field is optional so rows
// written by older builds load cleanly (callers default it to emptyTimeline()).
import type { Timeline } from './timeline';
export type SessionState = SamplerState & { timeline?: Timeline };

type CurveKind = 'linear' | 'exp' | 'log';

export type RecencyCurve = {
  curve: CurveKind;
  // Half-life in picks (entries in recentlyPlayed). All curves return [0,1].
  halfLifePicks: number;
};

export type SamplerConfig = {
  mix: { ratedPct: number; unratedPct: number };
  tierWeights: Record<RatingTier, number>;
  // 0..100 sliders, neutral = 50, exclude = 0. Each axis is keyed by candidate value.
  filters: {
    artists?: Record<string, number>;
    genres?: Record<string, number>;
    versionTypes?: Record<string, number>;
  };
  gates: {
    cooldownCount: { enabled: boolean; n: number };
    cooldownTime: { enabled: boolean; hours: number };
    dailyCap: { enabled: boolean; max: number };
  };
  recency: Record<RatingTier, RecencyCurve>;
};

// Neutral slider value. Used so filterWeight / 50 = 1.0 at "no opinion".
const NEUTRAL = 50;

export function tierOf(rating: number | null): RatingTier {
  if (rating == null) return 'unrated';
  const r = Math.max(1, Math.min(5, Math.round(rating)));
  return String(r) as RatingTier;
}

// Slider lookup, falling back to NEUTRAL when the axis doesn't mention the value.
function sliderFor(map: Record<string, number> | undefined, key: string | null): number {
  if (!map || key == null) return NEUTRAL;
  const v = map[key];
  return v == null ? NEUTRAL : v;
}

// 0 → excluded. Otherwise we divide by 50 so neutral = 1.0, "only" (100) = 2.0.
function filterMult(slider: number): number {
  return slider / NEUTRAL;
}

// Drops candidates that the mix dial wants to exclude entirely (mix=0 on one side).
// Soft mix is handled by the multiplier in baseScore.
export function applyMixSplit(pool: Candidate[], cfg: SamplerConfig): Candidate[] {
  const { ratedPct, unratedPct } = cfg.mix;
  return pool.filter((c) => {
    if (c.tier === 'unrated') return unratedPct > 0;
    return ratedPct > 0;
  });
}

export function gateOk(
  c: Candidate,
  state: SamplerState,
  cfg: SamplerConfig,
  now: number,
): boolean {
  // Slider=0 on any axis = hard exclude. Cheap; do first.
  if (cfg.tierWeights[c.tier] === 0) return false;
  if (sliderFor(cfg.filters.versionTypes, c.versionType) === 0) return false;
  for (const a of c.artistIds) {
    if (sliderFor(cfg.filters.artists, a) === 0) return false;
  }
  for (const g of c.genres) {
    if (sliderFor(cfg.filters.genres, g) === 0) return false;
  }

  if (cfg.gates.cooldownCount.enabled) {
    const n = cfg.gates.cooldownCount.n;
    if (state.recentlyPlayed.slice(0, n).includes(c.uri)) return false;
  }

  if (cfg.gates.cooldownTime.enabled) {
    const lastAt = state.recentlyPlayedAt[c.uri];
    if (lastAt != null) {
      const ageMs = now - lastAt;
      if (ageMs < cfg.gates.cooldownTime.hours * 3600_000) return false;
    }
  }

  if (cfg.gates.dailyCap.enabled) {
    const played = state.dailyPlayCounts[c.uri] ?? 0;
    if (played >= cfg.gates.dailyCap.max) return false;
  }

  return true;
}

export function baseScore(c: Candidate, cfg: SamplerConfig): number {
  const wTier = cfg.tierWeights[c.tier];
  if (wTier === 0) return 0;

  let wFilter = 1;
  // Per-axis: one multiplier per axis, not per value. Stacking would distort small pools.
  if (c.versionType != null) {
    const s = sliderFor(cfg.filters.versionTypes, c.versionType);
    if (s === 0) return 0;
    wFilter *= filterMult(s);
  }
  // Artist/genre filters compose multiplicatively per configured value the
  // candidate touches. Neutral entries (slider=50 or unmentioned) contribute 1×
  // and don't distort. Any 0 excludes outright. This preserves both penalties
  // (Coldplay at 20 → 0.4×) and boosts (Coldplay at 100 → 2×).
  for (const a of c.artistIds) {
    const s = cfg.filters.artists?.[a];
    if (s === undefined) continue;
    if (s === 0) return 0;
    wFilter *= filterMult(s);
  }
  for (const g of c.genres) {
    const s = cfg.filters.genres?.[g];
    if (s === undefined) continue;
    if (s === 0) return 0;
    wFilter *= filterMult(s);
  }

  const wMix = c.tier === 'unrated' ? cfg.mix.unratedPct / NEUTRAL : cfg.mix.ratedPct / NEUTRAL;
  return wTier * wFilter * wMix;
}

// "Picks ago" = index in recentlyPlayed (0 = most recent). Returns null if never played.
function picksAgo(uri: string, state: SamplerState): number | null {
  const i = state.recentlyPlayed.indexOf(uri);
  return i === -1 ? null : i;
}

function curveValue(x: number, c: RecencyCurve): number {
  const hl = Math.max(1, c.halfLifePicks);
  if (c.curve === 'linear') {
    return Math.max(0, Math.min(1, x / (2 * hl)));
  }
  if (c.curve === 'exp') {
    return 1 - Math.pow(2, -x / hl);
  }
  // log
  return Math.max(0, Math.min(1, Math.log(1 + x) / Math.log(1 + 2 * hl)));
}

export function recencyMultiplier(
  c: Candidate,
  state: SamplerState,
  cfg: SamplerConfig,
): number {
  const ago = picksAgo(c.uri, state);
  if (ago === null) return 1; // never played → no damping
  return curveValue(ago, cfg.recency[c.tier]);
}

export function weightedSample(
  items: { uri: string; weight: number }[],
  rand: () => number,
): string | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const it of items) total += Math.max(0, it.weight);
  if (total <= 0) return null;
  let r = rand() * total;
  for (const it of items) {
    r -= Math.max(0, it.weight);
    if (r <= 0) return it.uri;
  }
  // Floating-point fallthrough — pick last positive-weight item.
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].weight > 0) return items[i].uri;
  }
  return null;
}

export type PickInput = {
  candidates: Candidate[];
  state: SamplerState;
  config: SamplerConfig;
  now: number;
  rng: () => number;
};

// Progressive relaxation (spec §5). When strict gating leaves nothing eligible
// — the common cause being a library smaller than the cooldown window, where
// every track is "recently played" — we loosen gates in a fixed order until
// something passes, rather than stalling. Each step is cumulative.
//
// We deliberately do NOT relax weight=0 filters or tier weights: those are the
// user's explicit "never play this" choices, and silently overriding them would
// surprise. A library of only excluded tracks correctly yields null.
export type Relaxation = 'none' | 'drop_daily_cap' | 'halve_cooldowns' | 'drop_cooldowns';

const RELAX_ORDER: Relaxation[] = ['drop_daily_cap', 'halve_cooldowns', 'drop_cooldowns'];

function relaxConfig(cfg: SamplerConfig, level: Relaxation): SamplerConfig {
  // Cumulative: each level includes the loosening of the levels before it.
  const gates = { ...cfg.gates };
  if (level === 'drop_daily_cap' || level === 'halve_cooldowns' || level === 'drop_cooldowns') {
    gates.dailyCap = { ...gates.dailyCap, enabled: false };
  }
  if (level === 'halve_cooldowns') {
    gates.cooldownCount = { ...gates.cooldownCount, n: Math.floor(gates.cooldownCount.n / 2) };
    gates.cooldownTime = { ...gates.cooldownTime, hours: gates.cooldownTime.hours / 2 };
  }
  if (level === 'drop_cooldowns') {
    gates.cooldownCount = { ...gates.cooldownCount, enabled: false };
    gates.cooldownTime = { ...gates.cooldownTime, enabled: false };
  }
  return { ...cfg, gates };
}

export type PickResult = {
  uri: string | null;
  debug?: {
    poolSize: number;
    eligibleSize: number;
    winnerScore: number;
    relaxed: Relaxation;
  };
};

// Below this, a weight is treated as a floor rather than a true zero. Only used
// after relaxation: a track played 0 picks ago has recency multiplier 0, which
// would make it unsamplable even though we just relaxed gates specifically to
// allow replaying it. The floor keeps it pickable while recency still *orders*
// the pool (older plays outrank newer ones).
const RELAXED_WEIGHT_FLOOR = 1e-6;

export function pickNext(input: PickInput): PickResult {
  const { candidates, state, config, now, rng } = input;
  const mixed = applyMixSplit(candidates, config);

  let eligible = mixed.filter((c) => gateOk(c, state, config, now));
  let relaxed: Relaxation = 'none';
  let activeConfig = config;
  for (let i = 0; eligible.length === 0 && i < RELAX_ORDER.length; i++) {
    relaxed = RELAX_ORDER[i];
    activeConfig = relaxConfig(config, relaxed);
    eligible = mixed.filter((c) => gateOk(c, state, activeConfig, now));
  }

  if (eligible.length === 0) {
    return {
      uri: null,
      debug: { poolSize: candidates.length, eligibleSize: 0, winnerScore: 0, relaxed },
    };
  }

  const floor = relaxed === 'none' ? 0 : RELAXED_WEIGHT_FLOOR;
  const scored = eligible.map((c) => {
    const b = baseScore(c, activeConfig);
    const r = recencyMultiplier(c, state, activeConfig);
    return { uri: c.uri, weight: Math.max(b * r, b > 0 ? floor : 0) };
  });
  const winner = weightedSample(scored, rng);
  const winnerScore = winner ? (scored.find((s) => s.uri === winner)?.weight ?? 0) : 0;
  return {
    uri: winner,
    debug: {
      poolSize: candidates.length,
      eligibleSize: eligible.length,
      winnerScore,
      relaxed,
    },
  };
}

// State update: mutate-and-return a new state object so the caller can persist
// it atomically alongside the new play row. Caller supplies the cap so the
// recentlyPlayed ring doesn't grow without bound.
export function recordPlay(
  state: SamplerState,
  uri: string,
  now: number,
  ringCap: number,
): SamplerState {
  const recentlyPlayed = [uri, ...state.recentlyPlayed.filter((u) => u !== uri)].slice(0, ringCap);
  return {
    recentlyPlayed,
    recentlyPlayedAt: { ...state.recentlyPlayedAt, [uri]: now },
    dailyPlayCounts: {
      ...state.dailyPlayCounts,
      [uri]: (state.dailyPlayCounts[uri] ?? 0) + 1,
    },
    dailyResetAt: state.dailyResetAt,
  };
}
