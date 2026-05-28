// Find versions of a song: the user's already-rated tracks plus catalog
// tracks pulled from Spotify Search. Used by the OtherVersions UI on the
// track detail and now-playing pages.

import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';
import { fetchTrack, idFromUri, searchTracks, type SpotifyTrack } from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';
import { canonicalTitle } from '$lib/song-canonical';
import { sameSong, type Groupable } from '$lib/song-group';

export type VersionEntry = {
  uri: string;
  title: string;
  artists: string[];
  album: string | null;
  albumArtUrl: string | null;
  rating: number | null;       // null when not in user's library
  versionType: string | null;  // 'live' | 'acoustic' | … | null
};

export type SourceTrack = {
  uri: string;
  title: string;
  artists: string[];
  albumArtUrl: string | null;
  canonicalTitle: string;
  songFamilyId: string | null;
  isrc: string | null;
  // Lowercased set used for shared-artist filtering against catalog results.
  artistKeys: Set<string>;
};

/**
 * Resolve a URI to a source-track record. Prefers the local `tracks` row
 * (already enriched), falls back to fetching from Spotify so this works on
 * now-playing for tracks the user hasn't yet rated.
 */
export async function resolveSourceTrack(
  userId: string,
  uri: string,
): Promise<SourceTrack | null> {
  const rows = await db.execute<{
    title: string | null;
    artists: string[] | null;
    album_art_url: string | null;
    canonical_title: string | null;
    song_family_id: string | null;
    isrc: string | null;
  }>(sql`
    SELECT title, artists, album_art_url, canonical_title, song_family_id, isrc
    FROM tracks
    WHERE spotify_track_uri = ${uri}
    LIMIT 1
  `);

  let title: string | null = rows[0]?.title ?? null;
  let artists: string[] = rows[0]?.artists ?? [];
  let albumArtUrl: string | null = rows[0]?.album_art_url ?? null;
  let songFamilyId: string | null = rows[0]?.song_family_id ?? null;
  let storedCanonical: string | null = rows[0]?.canonical_title ?? null;
  let isrc: string | null = rows[0]?.isrc ?? null;

  if (!title || !isrc) {
    // Track isn't in our cache (or wasn't enriched with ISRC) — pull from
    // Spotify. Required for now-playing and for the MusicBrainz cover lookup.
    try {
      const { access_token } = await getValidAccessToken(userId);
      const t = await fetchTrack(access_token, idFromUri(uri));
      title = title ?? t.name;
      if (artists.length === 0) artists = t.artists.map((a) => a.name);
      if (!albumArtUrl) albumArtUrl = t.album.images[0]?.url ?? null;
      if (!isrc) isrc = t.external_ids?.isrc ?? null;
    } catch {
      // Continue with whatever we have — cover lookup will bail if isrc is null.
    }
  }

  if (!title) return null;
  const canon = storedCanonical?.trim() || canonicalTitle(title);
  return {
    uri,
    title,
    artists,
    albumArtUrl,
    canonicalTitle: canon,
    songFamilyId,
    isrc,
    artistKeys: new Set(artists.map((a) => a.trim().toLowerCase()).filter(Boolean)),
  };
}

type LibraryVersionRow = {
  uri: string;
  title: string | null;
  artists: string[] | null;
  album: string | null;
  album_art_url: string | null;
  rating: number;
  version_type: string | null;
  song_family_id: string | null;
  canonical_title: string | null;
};

/**
 * Tracks in the user's library that are versions of the same song.
 * Candidate set = tracks sharing at least one credited artist with the source.
 * Final filter via `sameSong` (runtime canonical with substring fallback).
 */
async function findLibraryVersions(
  userId: string,
  source: SourceTrack,
): Promise<VersionEntry[]> {
  if (source.artists.length === 0) return [];

  // Build a real text[] literal (ARRAY[$1, $2, …]). Interpolating the JS array
  // directly compiles to a row expression `($1, $2)`, which `&&` can't use.
  const artistsArray = sql`ARRAY[${sql.join(
    source.artists.map((a) => sql`${a}`),
    sql`, `,
  )}]::text[]`;

  const rows = await db.execute<LibraryVersionRow>(sql`
    SELECT
      t.spotify_track_uri AS uri,
      t.title AS title,
      t.artists AS artists,
      t.album AS album,
      t.album_art_url AS album_art_url,
      r.rating_stars AS rating,
      t.version_type AS version_type,
      t.song_family_id AS song_family_id,
      t.canonical_title AS canonical_title
    FROM ratings r
    JOIN tracks t ON t.spotify_track_uri = r.spotify_track_uri
    WHERE r.user_id = ${userId}
      AND t.spotify_track_uri <> ${source.uri}
      AND t.artists && ${artistsArray}
  `);

  const sourceGroupable: Groupable = {
    uri: source.uri,
    title: source.title,
    songFamilyId: source.songFamilyId,
    canonicalTitle: source.canonicalTitle,
  };

  const out: VersionEntry[] = [];
  for (const row of rows) {
    const candidate: Groupable = {
      uri: row.uri,
      title: row.title,
      songFamilyId: row.song_family_id,
      canonicalTitle: row.canonical_title,
    };
    if (!sameSong(sourceGroupable, candidate)) continue;
    out.push({
      uri: row.uri,
      title: row.title ?? 'Unknown',
      artists: row.artists ?? [],
      album: row.album,
      albumArtUrl: row.album_art_url,
      rating: row.rating,
      versionType: row.version_type,
    });
  }
  return out;
}

/**
 * Catalog versions from Spotify that aren't in the user's library. Search by
 * canonical title + primary artist so we don't drag in covers — covers are a
 * separate, opt-in feature (see musicbrainz.ts).
 */
async function findCatalogVersions(
  userId: string,
  source: SourceTrack,
  excludeUris: Set<string>,
): Promise<VersionEntry[]> {
  if (source.artists.length === 0) return [];
  const { access_token } = await getValidAccessToken(userId);
  // Scoped search: <canonical title> + primary artist. Fields MUST be quoted —
  // an unquoted `track:a b c` only binds the first token to the filter and
  // treats the rest as free text, which returns junk or nothing.
  const sanitize = (s: string) => s.replace(/["()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = `track:"${sanitize(source.canonicalTitle)}" artist:"${sanitize(source.artists[0])}"`;

  let results: SpotifyTrack[];
  try {
    results = await searchTracks(access_token, q, 10);
  } catch {
    return [];
  }

  const out: VersionEntry[] = [];
  for (const t of results) {
    if (excludeUris.has(t.uri)) continue;
    if (t.uri === source.uri) continue;

    // Shared artist (case-insensitive on name).
    const candArtists = t.artists.map((a) => a.name);
    const hasSharedArtist = candArtists.some((a) =>
      source.artistKeys.has(a.trim().toLowerCase()),
    );
    if (!hasSharedArtist) continue;

    const candidate: Groupable = {
      uri: t.uri,
      title: t.name,
      songFamilyId: null,
      canonicalTitle: null,
    };
    const sourceGroupable: Groupable = {
      uri: source.uri,
      title: source.title,
      songFamilyId: source.songFamilyId,
      canonicalTitle: source.canonicalTitle,
    };
    if (!sameSong(sourceGroupable, candidate)) continue;

    out.push({
      uri: t.uri,
      title: t.name,
      artists: candArtists,
      album: t.album.name ?? null,
      albumArtUrl: t.album.images[0]?.url ?? null,
      rating: null,
      versionType: null,
    });
    excludeUris.add(t.uri);
  }
  return out;
}

export async function findTrackVersions(
  userId: string,
  uri: string,
): Promise<{
  source: { uri: string; title: string; artists: string[]; albumArtUrl: string | null } | null;
  library: VersionEntry[];
  catalog: VersionEntry[];
}> {
  const source = await resolveSourceTrack(userId, uri);
  if (!source) return { source: null, library: [], catalog: [] };

  const library = await findLibraryVersions(userId, source);
  const excludeUris = new Set<string>([source.uri, ...library.map((v) => v.uri)]);
  const catalog = await findCatalogVersions(userId, source, excludeUris);

  // Sort library by rating desc then title; catalog by title.
  library.sort(
    (a, b) =>
      (b.rating ?? 0) - (a.rating ?? 0) ||
      a.title.toLowerCase().localeCompare(b.title.toLowerCase()),
  );
  catalog.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  return {
    source: {
      uri: source.uri,
      title: source.title,
      artists: source.artists,
      albumArtUrl: source.albumArtUrl,
    },
    library,
    catalog,
  };
}
