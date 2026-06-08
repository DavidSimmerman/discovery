import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';
import { artistScore, type ScoredTrack } from '$lib/server/artist-score';
import { getTopArtistRank, getTopTrackRank } from '$lib/server/top-lists';
import { groupSongs, type Groupable } from '$lib/song-group';

export type LibrarySort = 'recency' | 'rating' | 'name' | 'artist' | 'top';

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
  // Song-version metadata so callers (e.g. artist page) can collapse versions.
  // Nullable until the enrichment worker has touched the track.
  songFamilyId: string | null;
  canonicalTitle: string | null;
  primaryArtistId: string | null;
  versionType: string | null;
  album: string | null;
  plays: number;
};

export async function listLibrary(
  userId: string,
  opts: {
    search?: string;
    minRating?: number;
    label?: string;
    artist?: string;
    sort?: LibrarySort;
  },
): Promise<LibraryRow[]> {
  const { search, minRating, label, artist, sort = 'recency' } = opts;

  // Optional filters, AND-combined. Each is appended only when present so that
  // absent filters add no constraint. All values are bound parameters.
  const minRatingFilter =
    minRating !== undefined ? sql` AND r.rating_stars >= ${minRating}` : sql``;

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

  // Match any credited artist (primary OR featured) case-insensitively. Featured
  // artists land at positions > 1 in t.artists; unnest lets a feature pull the
  // track onto the featured artist's page too.
  const artistFilter =
    artist !== undefined
      ? sql` AND EXISTS (
          SELECT 1 FROM unnest(t.artists) a
          WHERE lower(trim(a)) = lower(trim(${artist}))
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
    song_family_id: string | null;
    canonical_title: string | null;
    primary_artist_id: string | null;
    version_type: string | null;
    album: string | null;
    plays_count: number;
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
      r.rating_stars AS rating,
      COALESCE(
        array_agg(l.name) FILTER (WHERE l.name IS NOT NULL),
        ARRAY[]::text[]
      ) AS labels,
      t.song_family_id AS song_family_id,
      t.canonical_title AS canonical_title,
      t.primary_artist_id AS primary_artist_id,
      t.version_type AS version_type,
      t.album AS album,
      COALESCE((
        SELECT count(*)::int FROM plays p
        WHERE p.user_id = ${userId} AND p.spotify_track_uri = base.uri
      ), 0) AS plays_count,
      GREATEST(
        COALESCE(r.rated_at, 'epoch'::timestamptz),
        COALESCE(max(tl.applied_at), 'epoch'::timestamptz)
      ) AS recency
    FROM base
    LEFT JOIN tracks t ON t.spotify_track_uri = base.uri
    LEFT JOIN ratings r ON r.spotify_track_uri = base.uri AND r.user_id = ${userId}
    LEFT JOIN track_labels tl ON tl.spotify_track_uri = base.uri AND tl.user_id = ${userId}
    LEFT JOIN labels l ON l.id = tl.label_id
    -- Joined so the rating sort can tiebreak by top-track rank without exposing
    -- the value to the client. NULL when the track isn't in the user's top 50.
    LEFT JOIN user_top_tracks utt ON utt.spotify_track_uri = base.uri AND utt.user_id = ${userId}
    WHERE TRUE${minRatingFilter}${labelFilter}${artistFilter}${searchFilter}
    GROUP BY base.uri, t.title, t.artists, t.album_art_url, r.rating_stars, r.rated_at, utt.rank,
             t.song_family_id, t.canonical_title, t.primary_artist_id, t.version_type, t.album
    ${orderBy(sort)}
    LIMIT 500
  `);

  return rows.map((row) => ({
    uri: row.uri,
    title: row.title,
    artists: row.artists ?? [],
    albumArtUrl: row.album_art_url,
    rating: row.rating,
    labels: row.labels,
    songFamilyId: row.song_family_id,
    canonicalTitle: row.canonical_title,
    primaryArtistId: row.primary_artist_id,
    versionType: row.version_type,
    album: row.album,
    plays: row.plays_count ?? 0,
  }));
}

export async function getLibraryTrack(
  userId: string,
  uri: string,
): Promise<LibraryRow | null> {
  const rows = await db.execute<{
    uri: string;
    title: string | null;
    artists: string[] | null;
    album_art_url: string | null;
    rating: number | null;
    labels: string[];
    song_family_id: string | null;
    canonical_title: string | null;
    primary_artist_id: string | null;
    version_type: string | null;
    album: string | null;
    plays_count: number;
  }>(sql`
    SELECT
      ${uri}::text AS uri,
      t.title AS title,
      t.artists AS artists,
      t.album_art_url AS album_art_url,
      r.rating_stars AS rating,
      COALESCE(
        array_agg(l.name) FILTER (WHERE l.name IS NOT NULL),
        ARRAY[]::text[]
      ) AS labels,
      t.song_family_id AS song_family_id,
      t.canonical_title AS canonical_title,
      t.primary_artist_id AS primary_artist_id,
      t.version_type AS version_type,
      t.album AS album,
      COALESCE((
        SELECT count(*)::int FROM plays p
        WHERE p.user_id = ${userId} AND p.spotify_track_uri = ${uri}
      ), 0) AS plays_count
    FROM (SELECT ${uri}::text AS uri) base
    LEFT JOIN tracks t ON t.spotify_track_uri = base.uri
    LEFT JOIN ratings r ON r.spotify_track_uri = base.uri AND r.user_id = ${userId}
    LEFT JOIN track_labels tl ON tl.spotify_track_uri = base.uri AND tl.user_id = ${userId}
    LEFT JOIN labels l ON l.id = tl.label_id
    WHERE EXISTS (
      SELECT 1 FROM ratings WHERE user_id = ${userId} AND spotify_track_uri = ${uri}
      UNION
      SELECT 1 FROM track_labels WHERE user_id = ${userId} AND spotify_track_uri = ${uri}
      UNION
      -- Also resolve cataloged-but-unrated tracks (e.g. an artist's "Top unrated"
      -- picks) so the track page can open them for rating without playback.
      SELECT 1 FROM tracks WHERE spotify_track_uri = ${uri}
    )
    GROUP BY t.title, t.artists, t.album_art_url, r.rating_stars,
             t.song_family_id, t.canonical_title, t.primary_artist_id, t.version_type, t.album
  `);

  const row = rows[0];
  if (!row) return null;
  return {
    uri: row.uri,
    title: row.title,
    artists: row.artists ?? [],
    albumArtUrl: row.album_art_url,
    rating: row.rating,
    labels: row.labels,
    songFamilyId: row.song_family_id,
    canonicalTitle: row.canonical_title,
    primaryArtistId: row.primary_artist_id,
    versionType: row.version_type,
    album: row.album,
    plays: row.plays_count ?? 0,
  };
}

function orderBy(sort: LibrarySort) {
  switch (sort) {
    case 'rating':
      // Tiebreak same-rated tracks by top-track rank (lower rank = more played).
      // NULLs (not in top 50) sort last so unranked tracks fall below ranked ones.
      return sql`ORDER BY r.rating_stars DESC NULLS LAST, utt.rank ASC NULLS LAST, recency DESC`;
    case 'name':
      return sql`ORDER BY lower(t.title) ASC NULLS LAST, recency DESC`;
    case 'artist':
      return sql`ORDER BY lower(t.artists[1]) ASC NULLS LAST, r.rating_stars DESC NULLS LAST, lower(t.title) ASC NULLS LAST`;
    case 'top':
      // "Top tracks" — rating first, then how often the user has actually played
      // it. Used by the Artist tab on now-playing to surface the user's most-loved,
      // most-spun songs by the current artist. Refers to plays_count by alias from
      // the outer SELECT (Postgres allows output-column references in ORDER BY).
      return sql`ORDER BY r.rating_stars DESC NULLS LAST, plays_count DESC, recency DESC`;
    case 'recency':
    default:
      return sql`ORDER BY recency DESC`;
  }
}

export type ArtistRow = {
  name: string;
  count: number;
  avg: number;
  score: number;
};

export async function listArtists(userId: string): Promise<ArtistRow[]> {
  // One row per (rating, credited artist) — unnest so featured artists get
  // credited for the track too, not just the primary. Song-version metadata
  // comes along so we can collapse duplicates per artist before scoring.
  const rows = await db.execute<{
    uri: string;
    name: string | null;
    rating_stars: number;
    title: string | null;
    song_family_id: string | null;
    canonical_title: string | null;
  }>(sql`
    SELECT
      r.spotify_track_uri AS uri,
      a AS name,
      r.rating_stars AS rating_stars,
      t.title AS title,
      t.song_family_id AS song_family_id,
      t.canonical_title AS canonical_title
    FROM ratings r
    JOIN tracks t ON t.spotify_track_uri = r.spotify_track_uri
    CROSS JOIN LATERAL unnest(t.artists) AS a
    WHERE r.user_id = ${userId}
      AND t.artists IS NOT NULL
      AND array_length(t.artists, 1) >= 1
  `);

  if (rows.length === 0) return [];

  // Top-artists/top-tracks ranks are served from the cached snapshot in
  // user_top_artists / user_top_tracks (refreshed daily by a frontend trigger).
  // If the cache is empty (brand-new user pre-first-refresh), the maps are
  // simply empty and scoring proceeds with no rank bonuses.
  const [topArtistRank, topTrackRank] = await Promise.all([
    getTopArtistRank(userId),
    getTopTrackRank(userId),
  ]);

  type RatedRow = Groupable & { stars: number };
  type Agg = { display: string; tracks: RatedRow[] };
  const byArtist = new Map<string, Agg>();

  for (const row of rows) {
    if (!row.name) continue;
    const key = row.name.trim().toLowerCase();
    if (key === '') continue;
    const entry: RatedRow = {
      uri: row.uri,
      title: row.title,
      songFamilyId: row.song_family_id,
      canonicalTitle: row.canonical_title,
      stars: row.rating_stars,
    };
    const g = byArtist.get(key);
    if (g) g.tracks.push(entry);
    else byArtist.set(key, { display: row.name.trim(), tracks: [entry] });
  }

  const out: ArtistRow[] = [];
  for (const [key, { display, tracks }] of byArtist.entries()) {
    // Collapse same-song duplicates within this artist's catalog. For each
    // group keep the version with the highest stars; tiebreak by top-track
    // bonus so a top-50 version outranks a duplicate that isn't ranked.
    const songGroups = groupSongs(tracks);
    const scored: ScoredTrack[] = [];
    const stars: number[] = [];
    for (const group of songGroups) {
      let best = group[0];
      let bestBonus = topTrackRank.get(best.uri) ?? null;
      for (let i = 1; i < group.length; i++) {
        const cand = group[i];
        const candBonus = topTrackRank.get(cand.uri) ?? null;
        if (
          cand.stars > best.stars ||
          (cand.stars === best.stars &&
            (candBonus ?? Number.POSITIVE_INFINITY) < (bestBonus ?? Number.POSITIVE_INFINITY))
        ) {
          best = cand;
          bestBonus = candBonus;
        }
      }
      scored.push({ stars: best.stars, trackRank: bestBonus });
      stars.push(best.stars);
    }

    const artistRank = topArtistRank.get(key) ?? null;
    out.push({
      name: display,
      count: stars.length,
      avg: stars.reduce((a, b) => a + b, 0) / stars.length,
      score: artistScore(scored, artistRank),
    });
  }

  // Default order: highest score first.
  out.sort((a, b) => b.score - a.score || b.count - a.count || a.name.localeCompare(b.name));
  return out;
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
