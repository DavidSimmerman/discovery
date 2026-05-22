import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchCurrentlyPlaying } from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';
import { upsertTrack, largestAlbumArtUrl } from '$lib/server/tracks';
import { db } from '$lib/server/db';
import { ratings } from '$lib/server/db/schema';
import { and, eq } from 'drizzle-orm';

const NO_STORE = { headers: { 'cache-control': 'no-store' } };

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const { access_token } = await getValidAccessToken(locals.user.id);
  const result = await fetchCurrentlyPlaying(access_token);

  if (!result || !result.item) {
    return json({ playing: null }, NO_STORE);
  }

  const item = result.item;

  try {
    await upsertTrack(item);
  } catch (err) {
    console.error('failed to upsert currently-playing track', err);
  }

  const [existing] = await db
    .select()
    .from(ratings)
    .where(and(eq(ratings.userId, locals.user.id), eq(ratings.spotifyTrackUri, item.uri)));

  return json(
    {
      playing: {
        uri: item.uri,
        name: item.name,
        artists: item.artists.map((a) => a.name),
        album: item.album?.name ?? null,
        albumArtUrl: largestAlbumArtUrl(item),
        durationMs: item.duration_ms,
        progressMs: result.progress_ms,
        isPlaying: result.is_playing,
        isrc: item.external_ids?.isrc ?? null,
      },
      rating: existing?.ratingHalfSteps ?? null,
    },
    NO_STORE,
  );
};
