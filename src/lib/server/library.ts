import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

// DB approach: src/lib/server/db/index.ts exports only the Drizzle `db` (the raw
// postgres-js client is module-private), so these UNION/aggregate queries are
// written as raw SQL via `db.execute(sql`...`)`. Drizzle's `sql` template
// parameterizes every `${value}` interpolation, so all user-supplied values below
// are bound parameters — never string-concatenated into the SQL text.

export type LibraryRow = {
  uri: string;
  title: string | null;
  artists: string[];
  albumArtUrl: string | null;
  rating: number | null;
  labels: string[];
};

export async function listLibrary(
  userId: string,
  opts: { search?: string; minRating?: number; label?: string },
): Promise<LibraryRow[]> {
  const { search, minRating, label } = opts;

  // Optional filters, AND-combined. Each is appended only when present so that
  // absent filters add no constraint. All values are bound parameters.
  const minRatingFilter =
    minRating !== undefined ? sql` AND r.rating_half_steps >= ${minRating}` : sql``;

  const labelFilter =
    label !== undefined
      ? sql` AND EXISTS (
          SELECT 1 FROM track_labels tlf
          JOIN labels lf ON lf.id = tlf.label_id
          WHERE tlf.user_id = ${userId}
            AND tlf.spotify_track_uri = base.uri
            AND lf.name = ${label}
        )`
      : sql``;

  const searchFilter =
    search !== undefined
      ? sql` AND (
          t.title ILIKE '%' || ${search} || '%'
          OR EXISTS (SELECT 1 FROM unnest(t.artists) a WHERE a ILIKE '%' || ${search} || '%')
          OR EXISTS (
            SELECT 1 FROM track_labels tls
            JOIN labels ls ON ls.id = tls.label_id
            WHERE tls.user_id = ${userId}
              AND tls.spotify_track_uri = base.uri
              AND ls.name ILIKE '%' || ${search} || '%'
          )
        )`
      : sql``;

  // recency = GREATEST(rating's rated_at, max applied_at across the track's labels),
  // each COALESCED to 'epoch' so a track present via only one of ratings/labels
  // still sorts by whichever timestamp it has. ORDER BY recency DESC = most recent first.
  const rows = await db.execute<{
    uri: string;
    title: string | null;
    artists: string[] | null;
    album_art_url: string | null;
    rating: number | null;
    labels: string[];
  }>(sql`
    WITH base AS (
      SELECT spotify_track_uri AS uri FROM ratings WHERE user_id = ${userId}
      UNION
      SELECT spotify_track_uri AS uri FROM track_labels WHERE user_id = ${userId}
    )
    SELECT
      base.uri AS uri,
      t.title AS title,
      t.artists AS artists,
      t.album_art_url AS album_art_url,
      r.rating_half_steps AS rating,
      COALESCE(
        array_agg(l.name) FILTER (WHERE l.name IS NOT NULL),
        ARRAY[]::text[]
      ) AS labels,
      GREATEST(
        COALESCE(r.rated_at, 'epoch'::timestamptz),
        COALESCE(max(tl.applied_at), 'epoch'::timestamptz)
      ) AS recency
    FROM base
    LEFT JOIN tracks t ON t.spotify_track_uri = base.uri
    LEFT JOIN ratings r ON r.spotify_track_uri = base.uri AND r.user_id = ${userId}
    LEFT JOIN track_labels tl ON tl.spotify_track_uri = base.uri AND tl.user_id = ${userId}
    LEFT JOIN labels l ON l.id = tl.label_id
    WHERE TRUE${minRatingFilter}${labelFilter}${searchFilter}
    GROUP BY base.uri, t.title, t.artists, t.album_art_url, r.rating_half_steps, r.rated_at
    ORDER BY recency DESC
    LIMIT 500
  `);

  return rows.map((row) => ({
    uri: row.uri,
    title: row.title,
    artists: row.artists ?? [],
    albumArtUrl: row.album_art_url,
    rating: row.rating,
    labels: row.labels,
  }));
}

export async function libraryFacets(
  userId: string,
): Promise<{ total: number; topLabels: { name: string; count: number }[] }> {
  const totalRows = await db.execute<{ total: number }>(sql`
    SELECT COUNT(*)::int AS total FROM (
      SELECT spotify_track_uri FROM ratings WHERE user_id = ${userId}
      UNION
      SELECT spotify_track_uri FROM track_labels WHERE user_id = ${userId}
    ) base
  `);

  const labelRows = await db.execute<{ name: string; count: number }>(sql`
    SELECT l.name AS name, COUNT(*)::int AS count
    FROM track_labels tl
    JOIN labels l ON l.id = tl.label_id
    WHERE tl.user_id = ${userId}
    GROUP BY l.name
    ORDER BY count DESC, l.name ASC
    LIMIT 8
  `);

  return {
    total: totalRows[0]?.total ?? 0,
    topLabels: labelRows.map((r) => ({ name: r.name, count: r.count })),
  };
}
