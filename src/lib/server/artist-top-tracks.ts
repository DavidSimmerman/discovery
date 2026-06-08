// "Top unrated by artist" — surfaces an artist's most popular songs the user
// hasn't rated yet, for the now-playing Artist tab.
//
// Spotify removed track `popularity` from its API (Feb 2026), so the ranking
// signal comes from Last.fm's artist.gettoptracks (global playcount order). We
// resolve those titles to Spotify URIs (DB-first, search fallback), cache the
// resolved catalog per artist in `artist_top_tracks`, and filter out the
// reader's already-rated tracks at read time. The cache is catalog-level (not
// user-scoped) — only the rated-filter is per-user.

import { db } from '$lib/server/db';
import { artistTopTracks, ratings, tracks } from '$lib/server/db/schema';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { fetchArtistTopTracks, type ArtistTopTrack } from '$lib/server/shuffle/providers/lastfm';
import { searchTracks, type SpotifyTrack } from '$lib/server/spotify';
import { listArtists } from '$lib/server/library';

// How long a cached artist catalog stays fresh before we re-pull from Last.fm.
export const ARTIST_CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// How many Last.fm tracks to pull/resolve per artist. We over-fetch beyond the
// 10 we show so that filtering out already-rated tracks still leaves a full list.
const CATALOG_FETCH_LIMIT = 30;
// Cap concurrent Spotify search calls when resolving cache misses.
const SEARCH_CONCURRENCY = 5;

export type CacheRow = {
  rank: number;
  lastfmTitle: string;
  spotifyTrackUri: string | null;
  isrc: string | null;
  album: string | null;
  albumArtUrl: string | null;
  playcount: number;
};

export type TopUnratedTrack = {
  uri: string;
  title: string;
  album: string | null;
  albumArtUrl: string | null;
  playcount: number;
  rank: number;
};

export type ArtistStats = {
  avg: number;
  rating: number; // composite artist score (same number the library list shows)
  rank: number; // 1-indexed position among the user's artists
  total: number; // how many artists the user has
  count: number; // songs rated for this artist
};

// ── pure helpers (unit-tested) ─────────────────────────────────────────────

/** Normalize an artist display name to the cache key: trimmed + lowercased. */
export function normalizeArtistKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Loose title key for DB-first matching: lowercased, punctuation stripped. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * From cached catalog rows, keep the ones that (a) resolved to a Spotify URI and
 * (b) the user hasn't rated (by URI or shared ISRC), in rank order, capped at
 * `limit`. Pure so it can be tested without a DB.
 */
export function pickTopUnrated(
  rows: CacheRow[],
  ratedUris: ReadonlySet<string>,
  ratedIsrcs: ReadonlySet<string>,
  limit: number,
): TopUnratedTrack[] {
  const out: TopUnratedTrack[] = [];
  for (const r of [...rows].sort((a, b) => a.rank - b.rank)) {
    if (!r.spotifyTrackUri) continue;
    if (ratedUris.has(r.spotifyTrackUri)) continue;
    if (r.isrc && ratedIsrcs.has(r.isrc)) continue;
    out.push({
      uri: r.spotifyTrackUri,
      title: r.lastfmTitle,
      album: r.album,
      albumArtUrl: r.albumArtUrl,
      playcount: r.playcount,
      rank: r.rank,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ── resolution + caching ───────────────────────────────────────────────────

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type Resolved = {
  uri: string | null;
  isrc: string | null;
  album: string | null;
  albumArtUrl: string | null;
};

const UNRESOLVED: Resolved = { uri: null, isrc: null, album: null, albumArtUrl: null };

function resolveFromSpotify(t: SpotifyTrack | undefined, artistKey: string): Resolved {
  if (!t?.uri) return UNRESOLVED;
  // Guard against search returning a same-titled track by a different artist.
  const credited = t.artists.some((a) => a.name.trim().toLowerCase() === artistKey);
  if (!credited) return UNRESOLVED;
  return {
    uri: t.uri,
    isrc: t.external_ids?.isrc ?? null,
    album: t.album?.name ?? null,
    albumArtUrl: t.album?.images?.[0]?.url ?? null,
  };
}

/**
 * Pull the artist's top tracks from Last.fm, resolve each to a Spotify track
 * (existing `tracks` rows first, then a Spotify search for misses), and replace
 * the cached catalog for this artist.
 */
async function refreshArtistCatalog(
  artistKey: string,
  artistName: string,
  accessToken: string,
): Promise<void> {
  const top: ArtistTopTrack[] = await fetchArtistTopTracks(artistName, CATALOG_FETCH_LIMIT);
  if (top.length === 0) {
    // Last.fm returned nothing. The client also returns [] on HTTP/API errors
    // and rate-limits, so we can't tell "no coverage" from "transient failure" —
    // keep any existing cached rows rather than wiping good data on a blip.
    return;
  }

  // DB-first: any track already in `tracks` credited to this artist.
  const dbRows = await db.execute<{
    uri: string;
    title: string;
    isrc: string | null;
    album: string | null;
    album_art_url: string | null;
  }>(sql`
    SELECT spotify_track_uri AS uri, title, isrc, album, album_art_url
    FROM tracks
    WHERE EXISTS (
      SELECT 1 FROM unnest(artists) a WHERE lower(a) = ${artistKey}
    )
  `);
  const byTitle = new Map<string, { uri: string; isrc: string | null; album: string | null; albumArtUrl: string | null }>();
  for (const r of dbRows) {
    const key = normalizeTitle(r.title);
    if (!byTitle.has(key)) {
      byTitle.set(key, { uri: r.uri, isrc: r.isrc, album: r.album, albumArtUrl: r.album_art_url });
    }
  }

  // Resolve misses via Spotify search (bounded concurrency).
  const resolved = await mapLimit(top, SEARCH_CONCURRENCY, async (t): Promise<Resolved> => {
    const hit = byTitle.get(normalizeTitle(t.title));
    if (hit) return hit;
    const results = await searchTracks(
      accessToken,
      `track:"${t.title.replace(/"/g, '')}" artist:"${artistName.replace(/"/g, '')}"`,
      1,
    );
    return resolveFromSpotify(results[0], artistKey);
  });

  const values = top.map((t, i) => ({
    artistKey,
    rank: t.rank,
    lastfmTitle: t.title,
    spotifyTrackUri: resolved[i].uri,
    isrc: resolved[i].isrc,
    album: resolved[i].album,
    albumArtUrl: resolved[i].albumArtUrl,
    playcount: t.playcount,
  }));

  // Dedupe on rank (Last.fm can, rarely, repeat a rank) — primary key is
  // (artist_key, rank), so collisions would abort the insert.
  const seenRank = new Set<number>();
  const deduped = values.filter((v) => (seenRank.has(v.rank) ? false : (seenRank.add(v.rank), true)));

  await db.transaction(async (tx) => {
    await tx.delete(artistTopTracks).where(eq(artistTopTracks.artistKey, artistKey));
    if (deduped.length > 0) await tx.insert(artistTopTracks).values(deduped);
  });
}

async function cacheIsFresh(artistKey: string): Promise<boolean> {
  const row = await db
    .select({ fetchedAt: artistTopTracks.fetchedAt })
    .from(artistTopTracks)
    .where(eq(artistTopTracks.artistKey, artistKey))
    .orderBy(sql`${artistTopTracks.fetchedAt} DESC`)
    .limit(1);
  const fetchedAt = row[0]?.fetchedAt;
  if (!fetchedAt) return false;
  return Date.now() - new Date(fetchedAt).getTime() < ARTIST_CATALOG_TTL_MS;
}

async function loadRatedSets(
  userId: string,
  uris: string[],
  isrcs: string[],
): Promise<{ ratedUris: Set<string>; ratedIsrcs: Set<string> }> {
  const ratedUris = new Set<string>();
  const ratedIsrcs = new Set<string>();
  if (uris.length === 0 && isrcs.length === 0) return { ratedUris, ratedIsrcs };
  const conds = [];
  if (uris.length > 0) conds.push(inArray(ratings.spotifyTrackUri, uris));
  if (isrcs.length > 0) conds.push(inArray(ratings.isrc, isrcs));
  const rated = await db
    .select({ uri: ratings.spotifyTrackUri, isrc: ratings.isrc })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), or(...conds)));
  for (const r of rated) {
    ratedUris.add(r.uri);
    if (r.isrc) ratedIsrcs.add(r.isrc);
  }
  return { ratedUris, ratedIsrcs };
}

/**
 * Top `limit` tracks by this artist the user hasn't rated, ranked by Last.fm
 * global playcount. Refreshes the cached catalog if stale/missing.
 */
export async function getArtistTopUnrated(
  userId: string,
  artistName: string,
  accessToken: string,
  limit = 10,
): Promise<TopUnratedTrack[]> {
  const artistKey = normalizeArtistKey(artistName);
  if (artistKey === '') return [];

  if (!(await cacheIsFresh(artistKey))) {
    try {
      await refreshArtistCatalog(artistKey, artistName, accessToken);
    } catch (err) {
      console.error('[artist-top-tracks] refresh failed', artistKey, err);
      // Fall through and serve whatever (possibly stale) cache exists.
    }
  }

  const rows = (await db
    .select({
      rank: artistTopTracks.rank,
      lastfmTitle: artistTopTracks.lastfmTitle,
      spotifyTrackUri: artistTopTracks.spotifyTrackUri,
      isrc: artistTopTracks.isrc,
      album: artistTopTracks.album,
      albumArtUrl: artistTopTracks.albumArtUrl,
      playcount: artistTopTracks.playcount,
    })
    .from(artistTopTracks)
    .where(eq(artistTopTracks.artistKey, artistKey))) as CacheRow[];

  const uris = rows.map((r) => r.spotifyTrackUri).filter((u): u is string => !!u);
  const isrcs = rows.map((r) => r.isrc).filter((i): i is string => !!i);
  const { ratedUris, ratedIsrcs } = await loadRatedSets(userId, uris, isrcs);

  return pickTopUnrated(rows, ratedUris, ratedIsrcs, limit);
}

/**
 * Artist stats for the now-playing Artist tab — average rating, composite score
 * ("rating"), and rank among the user's artists. Mirrors exactly what the
 * library artists list shows. Returns null if the user has no rated tracks for
 * this artist.
 */
export async function getArtistStats(
  userId: string,
  artistName: string,
): Promise<ArtistStats | null> {
  const key = normalizeArtistKey(artistName);
  if (key === '') return null;
  const artists = await listArtists(userId); // sorted by score desc
  const idx = artists.findIndex((a) => normalizeArtistKey(a.name) === key);
  if (idx === -1) return null;
  const row = artists[idx];
  return {
    avg: row.avg,
    rating: Math.round(row.score),
    rank: idx + 1,
    total: artists.length,
    count: row.count,
  };
}
