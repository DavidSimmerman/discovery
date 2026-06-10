// Catalogue of values the user can filter shuffle on, drawn from their own
// pool: artists / genres / version types from their rated library's track
// metadata, labels from their label set. Powers the Filters tab pickers.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;

  const [artists, genres, versionTypes, labels] = await Promise.all([
    // Primary artist of each rated track; name = first entry of tracks.artists.
    db.execute<{ id: string; name: string; n: number }>(sql`
      SELECT t.primary_artist_id AS id, MIN(t.artists[1]) AS name, COUNT(*)::int AS n
      FROM ratings r
      JOIN tracks t ON t.spotify_track_uri = r.spotify_track_uri
      WHERE r.user_id = ${userId} AND t.primary_artist_id IS NOT NULL
      GROUP BY t.primary_artist_id
      ORDER BY n DESC, name ASC
    `),
    db.execute<{ genre: string; n: number }>(sql`
      SELECT g.genre, COUNT(*)::int AS n
      FROM ratings r
      JOIN tracks t ON t.spotify_track_uri = r.spotify_track_uri
      CROSS JOIN LATERAL unnest(t.genres) AS g(genre)
      WHERE r.user_id = ${userId}
      GROUP BY g.genre
      ORDER BY n DESC, g.genre ASC
    `),
    db.execute<{ version_type: string; n: number }>(sql`
      SELECT t.version_type, COUNT(*)::int AS n
      FROM ratings r
      JOIN tracks t ON t.spotify_track_uri = r.spotify_track_uri
      WHERE r.user_id = ${userId} AND t.version_type IS NOT NULL
      GROUP BY t.version_type
      ORDER BY n DESC
    `),
    db.execute<{ id: string; name: string; n: number }>(sql`
      SELECT l.id, l.name, COUNT(tl.spotify_track_uri)::int AS n
      FROM labels l
      LEFT JOIN track_labels tl ON tl.label_id = l.id AND tl.user_id = l.user_id
      WHERE l.user_id = ${userId}
      GROUP BY l.id, l.name
      ORDER BY n DESC, l.name ASC
    `),
  ]);

  return json({
    artists: [...artists].map((a) => ({ id: a.id, name: a.name, count: a.n })),
    genres: [...genres].map((g) => ({ id: g.genre, name: g.genre, count: g.n })),
    versionTypes: [...versionTypes].map((v) => ({ id: v.version_type, count: v.n })),
    labels: [...labels].map((l) => ({ id: l.id, name: l.name, count: l.n })),
  });
};
