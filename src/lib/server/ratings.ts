// Rating lookup helpers shared between /api/ratings and /api/spotify/currently-playing.
//
// Spotify can serve the same recording under multiple track URIs (Smart Shuffle
// / Autoplay queueing a different album version, market-specific relinking,
// playlists containing duplicates from different releases). The DB primary key
// is (user_id, spotify_track_uri), so without an ISRC fallback the user sees
// "no rating" on the duplicate and re-rates it, creating two library rows.
//
// `findRatingByUriOrIsrc` first matches the exact URI; if nothing, it resolves
// the URI's ISRC via the `tracks` table and looks for any rating sharing that
// ISRC. Returns the canonical row so writers can update it in place instead of
// inserting a fresh row under the duplicate URI.

import { db } from '$lib/server/db';
import { ratings, tracks } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

export type FoundRating = {
  spotifyTrackUri: string;
  ratingStars: number;
};

export async function findRatingByUriOrIsrc(
  userId: string,
  uri: string,
): Promise<FoundRating | null> {
  const direct = await db
    .select({
      spotifyTrackUri: ratings.spotifyTrackUri,
      ratingStars: ratings.ratingStars,
    })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.spotifyTrackUri, uri)))
    .limit(1);
  if (direct[0]) return direct[0];

  const trackRow = await db
    .select({ isrc: tracks.isrc })
    .from(tracks)
    .where(eq(tracks.spotifyTrackUri, uri))
    .limit(1);
  const isrc = trackRow[0]?.isrc;
  if (!isrc) return null;

  const viaIsrc = await db
    .select({
      spotifyTrackUri: ratings.spotifyTrackUri,
      ratingStars: ratings.ratingStars,
    })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), eq(ratings.isrc, isrc)))
    .limit(1);
  return viaIsrc[0] ?? null;
}

// Resolve the ISRC for a URI from cached track metadata, or null if unknown.
export async function isrcForUri(uri: string): Promise<string | null> {
  const row = await db
    .select({ isrc: tracks.isrc })
    .from(tracks)
    .where(eq(tracks.spotifyTrackUri, uri))
    .limit(1);
  return row[0]?.isrc ?? null;
}
