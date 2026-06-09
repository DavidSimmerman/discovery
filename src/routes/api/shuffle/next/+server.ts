// Sampler-driven shuffle pick. Candidates come from the user's configured
// sources (library / playlists — see shuffle/config.ts + shuffle/sources.ts);
// sampler knobs come from the persisted per-user settings. The existing dumb
// shuffle in /now-playing keeps working — this is a separate route, opted into
// by the sampler-mode flag.
//
// Response: { uri, debug } — the client POSTs the URI to /api/spotify/player/play.
// The play row is *not* written here; it's written by the playback layer when
// the track actually starts (same as current flow). The sampler state IS
// updated here so back-to-back /next calls don't return the same URI.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { pickNext, recordPlay } from '$lib/server/shuffle/sampler';
import { effectiveSamplerConfig, poolSides } from '$lib/server/shuffle/config';
import { loadCandidates, prefetchPlaylists } from '$lib/server/shuffle/sources';
import { getValidAccessToken } from '$lib/server/tokens';
import {
  loadSessionState,
  loadUserSettings,
  saveSessionState,
  withUserSessionLock,
  RING_CAP,
} from '$lib/server/shuffle/session-store';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const now = Date.now();

  // Token fetch, settings read, and playlist prefetch all run OUTSIDE the
  // session lock: a cold playlist cache means seconds of paginated Spotify
  // fetches, which must not hold a DB transaction + advisory lock open.
  // Null token → playlist sources are skipped; the shuffle degrades to the
  // library source.
  const token = await getValidAccessToken(userId).catch(() => null);
  const settings = await loadUserSettings(db, userId);
  const prefetched = await prefetchPlaylists(
    token?.access_token ?? null,
    userId,
    settings.sources,
  );

  return await withUserSessionLock(userId, async (tx) => {
    const [candidates, state] = await Promise.all([
      loadCandidates(tx, userId, settings.sources, prefetched),
      loadSessionState(tx, userId, now),
    ]);

    if (candidates.length === 0) {
      return json({ uri: null, reason: 'no candidates for the configured sources' }, { status: 200 });
    }

    const config = effectiveSamplerConfig(settings, poolSides(settings.sources));
    const result = pickNext({ candidates, state, config, now, rng: Math.random });

    if (result.uri) {
      const nextState = recordPlay(state, result.uri, now, RING_CAP);
      // Preserve the timeline across the sampler-state write — recordPlay only
      // updates cooldown fields, but the persisted blob must carry it forward.
      await saveSessionState(tx, userId, { ...nextState, timeline: state.timeline }, settings);
    }

    return json(result);
  });
};
