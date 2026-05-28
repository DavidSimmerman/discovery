// Sampler-driven shuffle pick. v1: rated library only, default config.
// Stores per-user sampler state in shuffleSessions. The existing dumb shuffle
// in /now-playing keeps working — this is a new route, opted into by future
// client wiring, not a replacement.
//
// Response: { uri, debug } — the client POSTs the URI to /api/spotify/player/play.
// The play row is *not* written here; it's written by the playback layer when
// the track actually starts (same as current flow). The sampler state IS
// updated here so back-to-back /next calls don't return the same URI.
//
// Concurrency: we take a per-user Postgres advisory lock so concurrent /next
// requests for the same user serialize. Without it, two clicks in quick
// succession could each read the same state and return the same URI.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ratings, tracks, plays, shuffleSessions } from '$lib/server/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

// All of these run inside the per-user advisory-locked transaction. Typed loosely
// — the Drizzle `tx` param shape isn't worth importing for a one-call surface.
type DbExec = Parameters<Parameters<typeof db.transaction>[0]>[0];
import {
  pickNext,
  recordPlay,
  tierOf,
  type Candidate,
  type SamplerConfig,
  type SamplerState,
} from '$lib/server/shuffle/sampler';

const RING_CAP = 200;

const DEFAULT_CONFIG: SamplerConfig = {
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

function emptyState(now: number): SamplerState {
  return {
    recentlyPlayed: [],
    recentlyPlayedAt: {},
    dailyPlayCounts: {},
    dailyResetAt: now,
  };
}

async function loadCandidates(tx: DbExec, userId: string): Promise<Candidate[]> {
  // v1: just every rated track. Future slices will add unrated injection,
  // playlist/artist/discovery sources, family inheritance.
  const rows = await tx
    .select({
      uri: ratings.spotifyTrackUri,
      rating: ratings.ratingStars,
      primaryArtistId: tracks.primaryArtistId,
      genres: tracks.genres,
      versionType: tracks.versionType,
    })
    .from(ratings)
    .leftJoin(tracks, eq(tracks.spotifyTrackUri, ratings.spotifyTrackUri))
    .where(eq(ratings.userId, userId));

  return rows.map((r) => ({
    uri: r.uri,
    tier: tierOf(r.rating),
    rating: r.rating,
    artistIds: r.primaryArtistId ? [r.primaryArtistId] : [],
    genres: r.genres ?? [],
    versionType: r.versionType,
  }));
}

// Hydrate sampler state from the persisted blob + the last N plays. The
// persisted blob is the source of truth (it's written by /next itself, before
// a play row exists). The plays table is used to fill gaps — if a session row
// was lost, we can still reconstruct cooldowns from listening history.
async function loadState(tx: DbExec, userId: string, now: number): Promise<SamplerState> {
  const sess = await tx
    .select({ state: shuffleSessions.state })
    .from(shuffleSessions)
    .where(eq(shuffleSessions.userId, userId))
    .limit(1);

  const recent = await tx
    .select({ uri: plays.spotifyTrackUri, playedAt: plays.playedAt })
    .from(plays)
    .where(and(eq(plays.userId, userId), eq(plays.source, 'shuffle')))
    .orderBy(desc(plays.playedAt))
    .limit(RING_CAP);

  const fromPlays: Record<string, number> = {};
  for (const p of recent) {
    const ms = new Date(p.playedAt).getTime();
    if (!(p.uri in fromPlays)) fromPlays[p.uri] = ms;
  }

  const persisted = (sess[0]?.state ?? null) as SamplerState | null;
  // Persisted entries win — they reflect /next picks that may not yet have a
  // play row. Plays-table entries fill any gaps.
  const recentlyPlayedAt = { ...fromPlays, ...(persisted?.recentlyPlayedAt ?? {}) };
  return {
    recentlyPlayed: persisted?.recentlyPlayed ?? recent.map((p) => p.uri),
    recentlyPlayedAt,
    dailyPlayCounts: persisted?.dailyPlayCounts ?? {},
    dailyResetAt: persisted?.dailyResetAt ?? now,
  };
}

async function saveState(
  tx: DbExec,
  userId: string,
  state: SamplerState,
  cfg: SamplerConfig,
): Promise<void> {
  await tx
    .insert(shuffleSessions)
    .values({
      userId,
      activeConfig: cfg,
      state,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: shuffleSessions.userId,
      set: { state, activeConfig: cfg, updatedAt: sql`now()` },
    });
}

// Lock key for pg_advisory_xact_lock — stable per user. Two bigints derived
// from the userId hash so the lock namespace doesn't collide with anything else.
const LOCK_NAMESPACE = 0x5_4_8_F_F_1_E_3; // arbitrary, unique per feature

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const now = Date.now();

  return await db.transaction(async (tx) => {
    // Two-key advisory xact lock keyed on (LOCK_NAMESPACE, hashed userId).
    // Released automatically at commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      ${LOCK_NAMESPACE},
      ('x' || substr(md5(${userId}), 1, 8))::bit(32)::int
    )`);

    const [candidates, state] = await Promise.all([
      loadCandidates(tx, userId),
      loadState(tx, userId, now),
    ]);

    if (candidates.length === 0) {
      return json({ uri: null, reason: 'no rated tracks' }, { status: 200 });
    }

    const result = pickNext({
      candidates,
      state,
      config: DEFAULT_CONFIG,
      now,
      rng: Math.random,
    });

    if (result.uri) {
      const nextState = recordPlay(state, result.uri, now, RING_CAP);
      await saveState(tx, userId, nextState, DEFAULT_CONFIG);
    }

    return json(result);
  });
};
