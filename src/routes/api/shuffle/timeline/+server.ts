// Virtual timeline: history ++ [current] ++ upcoming, owned by disccovery
// (not Spotify, which can't remove or reorder its own playback queue). One
// endpoint, action-dispatched, mirroring /api/spotify/player/control.
//
// GET  → { timeline }
// POST { action, ... } → { timeline, picked? }
//
// Actions:
//   advance                                 — natural track-end or forward
//   forward                                 — synonym for advance, user-initiated
//   back                                    — back one step (current → upcoming, history.last → current)
//   add     { uri, position? }              — insert into upcoming
//   remove  { uri, index? }                 — remove from upcoming (index optional, for dupes)
//   reorder { fromIndex, toIndex }          — move within upcoming
//
// Sampler refill: after each advance/forward, if upcoming has fewer than
// TARGET_DEPTH items, the sampler is run until upcoming is full or the
// sampler returns null (exhausted).

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ratings, tracks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
  advance,
  back,
  forward,
  addToUpcoming,
  removeFromUpcoming,
  reorderUpcoming,
  refillTail,
  emptyTimeline,
  syncTo,
  type Timeline,
} from '$lib/server/shuffle/timeline';
import {
  pickNext,
  recordPlay,
  tierOf,
  type Candidate,
  type SamplerConfig,
  type SessionState,
} from '$lib/server/shuffle/sampler';
import {
  loadSessionState,
  saveSessionState,
  timelineOf,
  withUserSessionLock,
  RING_CAP,
  type DbExec,
} from '$lib/server/shuffle/session-store';

// Target queue depth. Car mode pushes [current, ...upcoming] as a real Spotify
// context, so this doubles as the push depth: Spotify gets ~50 tracks of runway
// for native NEXT/PREV before we have to re-push. Deep enough that most sessions
// never drain it; the client re-pushes (one sub-second re-seek) when low.
const TARGET_DEPTH = 50;
// Safety budget for the refill loop so the sampler returning duplicates can't
// spin forever. A handful of misses won't fill the queue; ~3× target is enough.
const REFILL_MAX_ATTEMPTS = TARGET_DEPTH * 3;

// Same default config as /api/shuffle/next. Worth deduplicating into a
// constant when slice 6 (user-tunable configs) lands.
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

async function loadCandidates(tx: DbExec, userId: string): Promise<Candidate[]> {
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

// Pull sampler picks until upcoming has TARGET_DEPTH items or the sampler
// gives up. Each pick updates the sampler state's cooldowns immediately so
// the next call within this loop respects them. Capped at REFILL_MAX_ATTEMPTS
// total iterations so a sampler that keeps returning duplicates (already in
// upcoming/current) can't spin forever — we'll just settle for a shorter queue.
function refillToTarget(
  state: SessionState,
  candidates: Candidate[],
  now: number,
): { state: SessionState; addedCount: number } {
  let tl = timelineOf(state);
  let s: SessionState = { ...state, timeline: tl };
  let added = 0;

  for (let attempts = 0; tl.upcoming.length < TARGET_DEPTH && attempts < REFILL_MAX_ATTEMPTS; attempts++) {
    const result = pickNext({
      candidates,
      state: s,
      config: DEFAULT_CONFIG,
      now,
      rng: Math.random,
    });
    if (!result.uri) break; // sampler exhausted; stop
    const nextTl = refillTail(tl, [result.uri]);
    // refillTail is a no-op when the pick is already current/upcoming. Don't
    // break on duplicates — record the cooldown and try again. Other unique
    // candidates may still be available; the attempts budget keeps us safe.
    if (nextTl.upcoming.length === tl.upcoming.length) {
      s = recordPlay(s, result.uri, now, RING_CAP);
      s.timeline = tl;
      continue;
    }
    tl = nextTl;
    s = { ...recordPlay(s, result.uri, now, RING_CAP), timeline: tl };
    added++;
  }
  return { state: s, addedCount: added };
}

// Read body once; SvelteKit's request.json() consumes the stream.
type Body =
  | { action: 'advance' | 'forward' | 'back' | 'reset' }
  | { action: 'sync'; uri: string }
  | { action: 'add'; uri: string; position?: number }
  | { action: 'remove'; uri: string; index?: number }
  | { action: 'reorder'; fromIndex: number; toIndex: number };

function applyAction(tl: Timeline, body: Body): Timeline {
  switch (body.action) {
    case 'advance':
    case 'forward': return advance(tl);
    case 'back':    return back(tl);
    // Car mode: follow Spotify's native playback by syncing the cursor to the
    // URI it actually landed on.
    case 'sync':    return syncTo(tl, body.uri);
    // Clear the whole timeline — history, current, and upcoming. The user hits
    // this via the Shuffle button to wipe a queue they don't like. Cooldowns
    // are intentionally NOT cleared (they live elsewhere in session state), so
    // a fresh shuffle still avoids recently-played repeats. The client follows
    // a reset with a forward to materialize a fresh first pick.
    case 'reset':   return emptyTimeline();
    case 'add':     return addToUpcoming(tl, body.uri, body.position);
    case 'remove':  return removeFromUpcoming(tl, body.uri, body.index);
    case 'reorder': return reorderUpcoming(tl, body.fromIndex, body.toIndex);
  }
}

// Reject fractional / non-finite numbers — Array slice/splice silently truncate
// them, which would let a malformed reorder mutate the wrong slot rather than
// returning a 400. Same for position/index.
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function validate(body: unknown): Body {
  if (typeof body !== 'object' || body === null || !('action' in body)) {
    throw error(400, 'missing action');
  }
  const b = body as { action?: unknown } & Record<string, unknown>;
  switch (b.action) {
    case 'advance':
    case 'forward':
    case 'back':
    case 'reset':
      return { action: b.action };
    case 'sync':
      if (typeof b.uri !== 'string') throw error(400, 'uri required');
      return { action: 'sync', uri: b.uri };
    case 'add':
      if (typeof b.uri !== 'string') throw error(400, 'uri required');
      if (b.position != null && !isNonNegInt(b.position)) throw error(400, 'position must be a non-negative integer');
      return { action: 'add', uri: b.uri, position: b.position as number | undefined };
    case 'remove':
      if (typeof b.uri !== 'string') throw error(400, 'uri required');
      if (b.index != null && !isNonNegInt(b.index)) throw error(400, 'index must be a non-negative integer');
      return { action: 'remove', uri: b.uri, index: b.index as number | undefined };
    case 'reorder':
      if (!isNonNegInt(b.fromIndex) || !isNonNegInt(b.toIndex)) {
        throw error(400, 'fromIndex and toIndex must be non-negative integers');
      }
      return { action: 'reorder', fromIndex: b.fromIndex, toIndex: b.toIndex };
    default:
      throw error(400, 'unknown action');
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const now = Date.now();
  return await withUserSessionLock(userId, async (tx) => {
    const state = await loadSessionState(tx, userId, now);
    return json({ timeline: timelineOf(state) });
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const body = validate(await request.json());
  const now = Date.now();

  return await withUserSessionLock(userId, async (tx) => {
    let nextState: SessionState = await loadSessionState(tx, userId, now);

    // advance/forward is the canonical refill trigger. back/add/remove/reorder
    // don't shrink upcoming, so we never refill on edits. Two-phase for forward:
    //   1. If upcoming is empty, refill BEFORE advancing so there's something
    //      to move to (otherwise advance is a no-op and the cursor stalls).
    //   2. Advance.
    //   3. Refill back up to TARGET_DEPTH. Pre-2026-06: this used a low-water
    //      hysteresis to skip refills on back→forward round-trips, but the user
    //      wants the Queue tab to always show 10 — the round-trip cost (≤7 picks
    //      on the first forward after a deeper drain) is acceptable. Once at
    //      target, back→forward round-trips do no extra work (back grows
    //      upcoming to 11, forward shrinks it back to 10).
    // Forward AND sync shrink upcoming (sync folds skipped tracks into history
    // when following Spotify forward), so both top the queue back up. back/add/
    // remove/reorder don't shrink upcoming, so they never refill.
    const isForward = body.action === 'advance' || body.action === 'forward';
    const shouldRefill = isForward || body.action === 'sync';
    let candidatesCache: Candidate[] | null = null;
    async function getCandidates(): Promise<Candidate[]> {
      if (candidatesCache == null) candidatesCache = await loadCandidates(tx, userId);
      return candidatesCache;
    }

    if (isForward && timelineOf(nextState).upcoming.length === 0) {
      const refilled = refillToTarget(nextState, await getCandidates(), now);
      nextState = refilled.state;
    }

    const tl = applyAction(timelineOf(nextState), body);
    nextState = { ...nextState, timeline: tl };

    if (shouldRefill && tl.upcoming.length < TARGET_DEPTH) {
      const refilled = refillToTarget(nextState, await getCandidates(), now);
      nextState = refilled.state;
    }

    await saveSessionState(tx, userId, nextState, DEFAULT_CONFIG);
    return json({ timeline: timelineOf(nextState) });
  });
};
