// Shared persistence + concurrency helpers for shuffleSessions.state.
//
// Both /api/shuffle/next and /api/shuffle/timeline/* read-modify-write the
// same row, so they share:
//   - The per-user advisory lock (so concurrent calls serialize, never
//     interleave their read/modify/write).
//   - The load helper, which folds the persisted blob and the recent plays
//     table together to reconstruct cooldowns when state is missing.
//   - The save helper.
//
// Keeping all three in one place means the lock key, the migration of older
// rows (timeline default, missing fields), and the upsert SQL only live here.

import { db } from '$lib/server/db';
import { plays, shuffleSessions } from '$lib/server/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { SessionState } from './sampler';
import { normalizeSettings, type ShuffleSettings } from './config';
import { emptyTimeline, type Timeline } from './timeline';

// Drizzle's transaction callback parameter — pulled out so endpoint code can
// declare helpers that accept either `db` or a transaction without importing
// internals.
export type DbExec = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Cap on recentlyPlayed length and the depth we pull from the plays table to
// reconstruct cooldowns when a session row is missing or stale.
export const RING_CAP = 200;

// Arbitrary 32-bit value used as the first key of pg_advisory_xact_lock. Pair
// it with a hash of the userId for a per-user, per-feature lock that's
// released automatically at commit/rollback.
const LOCK_NAMESPACE = 0x5_4_8_F_F_1_E_3;

// Run `body` inside a per-user serialized transaction. Both shuffle endpoints
// need this — losing the lock means concurrent /next clicks can hand out the
// same URI, and concurrent timeline edits can stomp each other.
export async function withUserSessionLock<T>(
  userId: string,
  body: (tx: DbExec) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(
      ${LOCK_NAMESPACE},
      ('x' || substr(md5(${userId}), 1, 8))::bit(32)::int
    )`);
    return await body(tx);
  });
}

// Hydrate state from the persisted blob, with cooldowns reconstructed from
// `plays` when the blob is missing fields (e.g. row written by an older build,
// or row never created). The persisted blob is the source of truth — /next
// writes it before any play row exists — but the plays table is the safety
// net.
export async function loadSessionState(
  tx: DbExec,
  userId: string,
  now: number,
): Promise<SessionState> {
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

  const persisted = (sess[0]?.state ?? null) as Partial<SessionState> | null;
  return {
    recentlyPlayed: persisted?.recentlyPlayed ?? recent.map((p) => p.uri),
    // Persisted entries win — they reflect picks that haven't yet produced a
    // play row. Plays-table values fill any gaps.
    recentlyPlayedAt: { ...fromPlays, ...(persisted?.recentlyPlayedAt ?? {}) },
    dailyPlayCounts: persisted?.dailyPlayCounts ?? {},
    dailyResetAt: persisted?.dailyResetAt ?? now,
    timeline: persisted?.timeline ?? emptyTimeline(),
  };
}

// Persist sampler/timeline state. activeConfig is set on INSERT only (the
// column is NOT NULL) — on update it's left alone, so a pick that loaded
// settings before taking the lock can never clobber a settings save that
// happened in between. Settings writes go through saveUserSettings only.
export async function saveSessionState(
  tx: DbExec,
  userId: string,
  state: SessionState,
  settings: ShuffleSettings,
): Promise<void> {
  await tx
    .insert(shuffleSessions)
    .values({ userId, activeConfig: settings, state, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: shuffleSessions.userId,
      set: { state, updatedAt: sql`now()` },
    });
}

// The user's persisted shuffle settings (sources + sampler knobs), from
// shuffleSessions.activeConfig. Older rows hold a bare SamplerConfig;
// normalizeSettings folds every generation forward. Missing row → defaults.
export async function loadUserSettings(
  exec: Pick<DbExec, 'select'>,
  userId: string,
): Promise<ShuffleSettings> {
  const rows = await exec
    .select({ activeConfig: shuffleSessions.activeConfig })
    .from(shuffleSessions)
    .where(eq(shuffleSessions.userId, userId))
    .limit(1);
  return normalizeSettings(rows[0]?.activeConfig ?? null);
}

// Persist settings without touching sampler state — the settings UI saves
// through this; only activeConfig changes. Creates the row when missing so a
// user can configure sources before their first shuffle.
export async function saveUserSettings(
  tx: DbExec,
  userId: string,
  settings: ShuffleSettings,
): Promise<void> {
  await tx
    .insert(shuffleSessions)
    .values({
      userId,
      activeConfig: settings,
      // Empty blob, not an empty SessionState: loadSessionState falls back to
      // the plays table per missing field, so cooldowns survive a settings
      // save that races the user's first shuffle.
      state: {},
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: shuffleSessions.userId,
      set: { activeConfig: settings, updatedAt: sql`now()` },
    });
}

// Convenience for endpoint code that doesn't care about the timeline vs.
// sampler split — returns the timeline with the empty-default already applied.
export function timelineOf(state: SessionState): Timeline {
  return state.timeline ?? emptyTimeline();
}
