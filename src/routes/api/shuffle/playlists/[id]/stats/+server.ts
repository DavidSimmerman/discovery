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
import { partitionRated } from '$lib/server/shuffle/rated-partition';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const token = await getValidAccessToken(userId);

  const snapshotId = await getPlaylistSnapshotCached(token.access_token, userId, params.id);
  const tracks = await getPlaylistTracksCached(token.access_token, userId, params.id, snapshotId);

  const rows = await db
    .select({ uri: ratings.spotifyTrackUri, isrc: ratings.isrc })
    .from(ratings)
    .where(eq(ratings.userId, userId));
  const { total, rated } = partitionRated(tracks, rows);

  return json({ total, rated, unrated: total - rated });
};
