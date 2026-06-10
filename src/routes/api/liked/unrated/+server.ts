// Unrated Liked Songs — backs the now-playing alert count, the Library
// callout, and the /liked review list. Saved tracks come through the same
// snapshot cache the shuffle source uses, so a fresh count after rating a
// song is cheap (cache hit) and the numbers always agree with the picker.
//
// GET            → { total, rated, unrated, tracks } (tracks = the unrated ones)
// GET ?count=1   → { total, rated, unrated } (no track list; for badges)

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
import { LIKED_SONGS_ID } from '$lib/liked';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const token = await getValidAccessToken(userId);

  const snapshotId = await getPlaylistSnapshotCached(token.access_token, userId, LIKED_SONGS_ID);
  const tracks = await getPlaylistTracksCached(
    token.access_token,
    userId,
    LIKED_SONGS_ID,
    snapshotId,
  );

  const rows = await db
    .select({ uri: ratings.spotifyTrackUri, isrc: ratings.isrc })
    .from(ratings)
    .where(eq(ratings.userId, userId));
  const { total, rated, unrated } = partitionRated(tracks, rows);

  if (url.searchParams.get('count') === '1') {
    return json({ total, rated, unrated: unrated.length });
  }

  return json({
    total,
    rated,
    unrated: unrated.length,
    // /me/tracks order = most recently liked first; keep it.
    tracks: unrated.map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => a.name),
      albumArtUrl: t.albumArtUrl ?? null,
      durationMs: t.durationMs ?? null,
      isrc: t.isrc,
    })),
  });
};
