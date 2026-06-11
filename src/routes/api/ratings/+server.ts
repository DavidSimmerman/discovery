import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ratings } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';
import { findRatingByUriOrIsrc, isrcForUri } from '$lib/server/ratings';
import { autoEnrichIfBehind } from '$lib/server/shuffle/enrichment';
import { ensureSavedTrack } from '$lib/server/spotify-library';

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = url.searchParams.get('uri');
  if (!uri) throw error(400, 'uri required');
  if (!TRACK_URI_RE.test(uri)) throw error(400, 'invalid uri');
  const found = await findRatingByUriOrIsrc(locals.user.id, uri);
  return json({ ratingStars: found?.ratingStars ?? null });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri, ratingStars, isrc } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }
  if (
    !Number.isInteger(ratingStars) ||
    ratingStars < 1 ||
    ratingStars > 5
  ) {
    throw error(400, 'ratingStars must be an integer between 1 and 5');
  }

  // Prefer the ISRC the client passed (e.g. from Spotify's currently-playing
  // payload). Fall back to whatever we have cached in `tracks`, so a rating
  // started via the Web Playback SDK (which doesn't expose ISRC client-side)
  // can still dedupe.
  const effectiveIsrc: string | null =
    typeof isrc === 'string' && isrc.length > 0 ? isrc : await isrcForUri(spotifyTrackUri);

  // If an existing rating shares this URI, update it. Otherwise, if one shares
  // the ISRC, update that row in place (keeps the original URI as canonical so
  // we don't proliferate rows for the same recording).
  const existing = await findRatingByUriOrIsrc(locals.user.id, spotifyTrackUri);

  if (existing) {
    await db
      .update(ratings)
      .set({ ratingStars, isrc: effectiveIsrc, ratedAt: new Date() })
      .where(
        and(
          eq(ratings.userId, locals.user.id),
          eq(ratings.spotifyTrackUri, existing.spotifyTrackUri),
        ),
      );
  } else {
    await db.insert(ratings).values({
      userId: locals.user.id,
      spotifyTrackUri,
      ratingStars,
      isrc: effectiveIsrc,
    });
  }

  // A fresh rating may reference a never-enriched track; catch the backfill up
  // in the background (guarded + cooldown inside autoEnrichIfBehind).
  void autoEnrichIfBehind(locals.user.id);

  // 2+ stars -> mirror into Spotify Liked Songs (skips already-liked tracks;
  // best-effort, never blocks or fails the rating). Downgrades don't remove.
  if (ratingStars >= 2) void ensureSavedTrack(locals.user.id, spotifyTrackUri);

  nudgeLiveActivity(locals.user.id);

  return json({ ok: true, ratingStars });
};

// Refresh the user's iOS Live Activity (if any) so a rating set in the web UI
// shows on the lock screen immediately. Dynamic import keeps the poller's
// Spotify/APNs dependency graph out of this route's unit tests; best-effort,
// never blocks or fails the response.
function nudgeLiveActivity(userId: string) {
  void import('$lib/server/liveActivityPoller')
    .then(({ nudgeUserActivities }) => nudgeUserActivities(userId))
    .catch(() => {});
}

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }

  // Delete the canonical row (which may be under a different URI sharing the ISRC).
  const existing = await findRatingByUriOrIsrc(locals.user.id, spotifyTrackUri);
  const targetUri = existing?.spotifyTrackUri ?? spotifyTrackUri;

  await db
    .delete(ratings)
    .where(and(eq(ratings.userId, locals.user.id), eq(ratings.spotifyTrackUri, targetUri)));

  nudgeLiveActivity(locals.user.id);

  return json({ ok: true });
};
