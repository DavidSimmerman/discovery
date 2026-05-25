import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ratings } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = url.searchParams.get('uri');
  if (!uri) throw error(400, 'uri required');
  if (!TRACK_URI_RE.test(uri)) throw error(400, 'invalid uri');
  const row = await db
    .select({ ratingHalfSteps: ratings.ratingHalfSteps })
    .from(ratings)
    .where(and(eq(ratings.userId, locals.user.id), eq(ratings.spotifyTrackUri, uri)))
    .limit(1);
  return json({ ratingHalfSteps: row[0]?.ratingHalfSteps ?? null });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri, ratingHalfSteps, isrc } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }
  if (
    !Number.isInteger(ratingHalfSteps) ||
    ratingHalfSteps < 1 ||
    ratingHalfSteps > 10
  ) {
    throw error(400, 'ratingHalfSteps must be an integer between 1 and 10');
  }

  await db
    .insert(ratings)
    .values({
      userId: locals.user.id,
      spotifyTrackUri,
      ratingHalfSteps,
      isrc: isrc ?? null,
    })
    .onConflictDoUpdate({
      target: [ratings.userId, ratings.spotifyTrackUri],
      set: { ratingHalfSteps, isrc: isrc ?? null, ratedAt: new Date() },
    });

  return json({ ok: true, ratingHalfSteps });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const body = await request.json();
  const { spotifyTrackUri } = body ?? {};

  if (typeof spotifyTrackUri !== 'string' || !TRACK_URI_RE.test(spotifyTrackUri)) {
    throw error(400, 'invalid spotifyTrackUri');
  }

  await db
    .delete(ratings)
    .where(and(eq(ratings.userId, locals.user.id), eq(ratings.spotifyTrackUri, spotifyTrackUri)));

  return json({ ok: true });
};
