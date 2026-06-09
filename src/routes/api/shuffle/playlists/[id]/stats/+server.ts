// Rated/unrated breakdown of one playlist against the user's ratings. Backs
// the "247 unrated · 1,204 total" line in the source picker; the client calls
// this per playlist with limited concurrency. Track lists are snapshot-cached,
// so re-opens are cheap.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { ratings } from '$lib/server/db/schema';
import { getValidAccessToken } from '$lib/server/tokens';
import {
  getPlaylistSnapshotCached,
  getPlaylistTracksCached,
} from '$lib/server/shuffle/playlist-cache';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const token = await getValidAccessToken(userId);

  const snapshotId = await getPlaylistSnapshotCached(token.access_token, userId, params.id);
  const tracks = await getPlaylistTracksCached(token.access_token, userId, params.id, snapshotId);

  // Rated = URI match OR ISRC match, mirroring the candidate loader — the
  // picker's "N unrated" must agree with what an "Unrated only" shuffle plays.
  const rows = await db
    .select({ uri: ratings.spotifyTrackUri, isrc: ratings.isrc })
    .from(ratings)
    .where(eq(ratings.userId, userId));
  const ratedUris = new Set(rows.map((r) => r.uri));
  const ratedIsrcs = new Set(rows.map((r) => r.isrc).filter((i): i is string => i != null));

  const seen = new Set<string>();
  let total = 0;
  let rated = 0;
  for (const t of tracks) {
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    total++;
    if (ratedUris.has(t.uri) || (t.isrc != null && ratedIsrcs.has(t.isrc))) rated++;
  }

  return json({ total, rated, unrated: total - rated });
};
