// Sampler-driven shuffle pick. v1: rated library only, default config.
// Stores per-user sampler state in shuffleSessions. The existing dumb shuffle
// in /now-playing keeps working — this is a new route, opted into by the
// sampler-mode flag, not a replacement.
//
// Response: { uri, debug } — the client POSTs the URI to /api/spotify/player/play.
// The play row is *not* written here; it's written by the playback layer when
// the track actually starts (same as current flow). The sampler state IS
// updated here so back-to-back /next calls don't return the same URI.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ratings, tracks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
  pickNext,
  recordPlay,
  tierOf,
  type Candidate,
  type SamplerConfig,
} from '$lib/server/shuffle/sampler';
import {
  loadSessionState,
  saveSessionState,
  withUserSessionLock,
  RING_CAP,
  type DbExec,
} from '$lib/server/shuffle/session-store';

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

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const now = Date.now();

  return await withUserSessionLock(userId, async (tx) => {
    const [candidates, state] = await Promise.all([
      loadCandidates(tx, userId),
      loadSessionState(tx, userId, now),
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
      // Preserve the timeline across the sampler-state write — recordPlay only
      // updates cooldown fields, but the persisted blob must carry it forward.
      await saveSessionState(
        tx,
        userId,
        { ...nextState, timeline: state.timeline },
        DEFAULT_CONFIG,
      );
    }

    return json(result);
  });
};
