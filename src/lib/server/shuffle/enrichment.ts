// Backfill worker: takes a user's rated library and populates the shuffle-system
// derived columns + provider caches. Idempotent — re-running skips tracks whose
// `primary_artist_id` is already set.
//
// Per track:
//   1. /v1/tracks  → release_date, explicit, artist list (with ids), isrc
//   2. /v1/artists → genres + names → artists + track_artists join
//   3. derive canonical_title / version_type / primary_artist_id / song_family_id
//   4. assign duplicate_group_id within the family
//   5. ReccoBeats audio-features (cache-or-fetch)
//   6. MusicBrainz by ISRC → track_works + track_credits (+ work credits if mbid present)
//   7. (top-rated tracks only) Last.fm similars → resolve to URIs → track_similars
//
// (A former step 8 — Spotify artist top-tracks cache seeding — was removed when
// Spotify dropped GET /artists/{id}/top-tracks in Feb 2026. The user-facing
// "Top unrated by artist" feature is Last.fm-driven and unaffected.)
//
// Rate-limit notes:
//   - Spotify: single-resource GETs in a small pool (batch endpoints were
//     removed Feb 2026); 429s retried per Retry-After inside spotify.ts.
//   - ReccoBeats: batched in 40s; unauthenticated, best-effort.
//   - MusicBrainz: 1 req/s serialized via providers/musicbrainz.ts.
//   - Last.fm: untracked; coverage is patchy on indie so failures are normal.

import { db } from '$lib/server/db';
import {
  tracks,
  artists,
  trackArtists,
  ratings,
  trackWorks,
  trackCredits,
  trackSimilars,
} from '$lib/server/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  fetchTracks,
  fetchArtists,
  searchTrack,
  idFromUri,
  type SpotifyTrack,
} from '$lib/server/spotify';
import { largestAlbumArtUrl } from '$lib/server/tracks';
import {
  canonicalTitle,
  detectVersionType,
  songFamilyId,
  isApparentDuplicate,
  type VersionType,
} from './version-detector';
import { getCachedAudioFeatures } from './providers/reccobeats';
import { fetchRecordingByIsrc, fetchWorkCredits } from './providers/musicbrainz';
import { fetchSimilarTracks } from './providers/lastfm';

// Whole-star rating threshold above which we'll burn Last.fm + search-API calls
// to populate similars. 4 = 4 stars; tuned to keep cost down on big libraries.
const SIMILARS_RATING_THRESHOLD = 4;

// How many tracks to process per inner batch before yielding to the event loop.
// Spotify batch ceilings are 50; keep below that.
const BATCH_SIZE = 25;

// Per-user concurrency guard. Process-local; fine for single-instance deploy.
const runningUsers = new Set<string>();

export interface EnrichmentStatus {
  ratedCount: number;
  enrichedCount: number;
  running: boolean;
}

export async function getEnrichmentStatus(userId: string): Promise<EnrichmentStatus> {
  // Rated URIs (the work universe). Tracks enriched (have primary_artist_id) that
  // are also rated by this user are "done."
  const [ratedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ratings)
    .where(eq(ratings.userId, userId));
  const [enrichedRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ratings)
    .innerJoin(tracks, eq(tracks.spotifyTrackUri, ratings.spotifyTrackUri))
    .where(and(eq(ratings.userId, userId), sql`${tracks.primaryArtistId} is not null`));
  return {
    ratedCount: ratedRow?.n ?? 0,
    enrichedCount: enrichedRow?.n ?? 0,
    running: runningUsers.has(userId),
  };
}

export interface EnrichOptions {
  // Cap how many tracks this run touches; useful for incremental smoke tests.
  limit?: number;
  // Skip Last.fm + MB lookups (purely for fast unit-like smoke).
  skipExternal?: boolean;
}

/**
 * Enrich every unenriched rated track for `userId`. Idempotent. Safe to call
 * concurrently — second call returns immediately. Errors per-track are logged
 * and swallowed so one bad row doesn't kill the run.
 */
export async function enrichUserLibrary(
  userId: string,
  accessToken: string,
  opts: EnrichOptions = {},
): Promise<{ processed: number; failed: number }> {
  if (runningUsers.has(userId)) return { processed: 0, failed: 0 };
  runningUsers.add(userId);
  try {
    const candidateUris = await unenrichedUrisForUser(userId, opts.limit);
    const ratingByUri = await ratingsForUris(userId, candidateUris);

    let processed = 0;
    let failed = 0;
    for (let i = 0; i < candidateUris.length; i += BATCH_SIZE) {
      const batch = candidateUris.slice(i, i + BATCH_SIZE);
      try {
        await enrichBatch(userId, accessToken, batch, ratingByUri, opts);
        processed += batch.length;
      } catch (err) {
        console.warn('[enrichment] batch failed', err);
        failed += batch.length;
      }
      // Yield to the event loop so the request queue stays responsive.
      await new Promise((r) => setImmediate(r));
    }
    return { processed, failed };
  } finally {
    runningUsers.delete(userId);
  }
}

async function unenrichedUrisForUser(userId: string, limit?: number): Promise<string[]> {
  // Rated URIs whose tracks row has no primary_artist_id (either missing entirely
  // or never enriched). LEFT JOIN with predicate covers both cases.
  const rows = await db
    .select({ uri: ratings.spotifyTrackUri })
    .from(ratings)
    .leftJoin(tracks, eq(tracks.spotifyTrackUri, ratings.spotifyTrackUri))
    .where(and(eq(ratings.userId, userId), isNull(tracks.primaryArtistId)))
    .limit(limit ?? 100_000);
  return rows.map((r) => r.uri);
}

async function ratingsForUris(
  userId: string,
  uris: string[],
): Promise<Map<string, number>> {
  if (uris.length === 0) return new Map();
  const rows = await db
    .select({ uri: ratings.spotifyTrackUri, r: ratings.ratingStars })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), inArray(ratings.spotifyTrackUri, uris)));
  return new Map(rows.map((r) => [r.uri, r.r]));
}

async function enrichBatch(
  userId: string,
  accessToken: string,
  uris: string[],
  ratingByUri: Map<string, number>,
  opts: EnrichOptions,
): Promise<void> {
  // Step 1: pull full Spotify track payloads (pooled single GETs).
  const spotifyTracks = await fetchTracks(accessToken, uris);
  if (spotifyTracks.length === 0) return;

  // Step 2: gather every artist id we need, fetch artists, persist.
  const artistIds = Array.from(
    new Set(
      spotifyTracks.flatMap((t) => t.artists.map((a) => a.id).filter((x): x is string => !!x)),
    ),
  );
  const artistRows = await fetchArtists(accessToken, artistIds);
  if (artistRows.length > 0) {
    await db
      .insert(artists)
      .values(
        artistRows.map((a) => ({
          spotifyArtistId: a.id,
          name: a.name,
          genres: a.genres,
        })),
      )
      .onConflictDoUpdate({
        target: artists.spotifyArtistId,
        set: {
          name: sql`excluded.name`,
          genres: sql`excluded.genres`,
          fetchedAt: new Date(),
        },
      });
  }
  const artistGenres = new Map(artistRows.map((a) => [a.id, a.genres]));

  // Step 3 (+ persist Step 1 + Step 2 join): upsert tracks with all derived fields,
  // then rewrite track_artists rows.
  for (const t of spotifyTracks) {
    const primaryArtistId = t.artists[0]?.id ?? null;
    const canonical = canonicalTitle(t.name);
    const versionType = detectVersionType(t.name, t.album?.name ?? null);
    const family = songFamilyId(primaryArtistId, canonical);
    const genres = primaryArtistId ? (artistGenres.get(primaryArtistId) ?? []) : [];

    await db
      .insert(tracks)
      .values({
        spotifyTrackUri: t.uri,
        isrc: t.external_ids?.isrc ?? null,
        title: t.name,
        artists: t.artists.map((a) => a.name),
        album: t.album?.name ?? null,
        albumArtUrl: largestAlbumArtUrl(t),
        durationMs: t.duration_ms,
        releaseDate: parseReleaseDate(t.album?.release_date),
        explicit: t.explicit ?? null,
        genres,
        primaryArtistId,
        canonicalTitle: canonical,
        versionType,
        songFamilyId: family,
      })
      .onConflictDoUpdate({
        target: tracks.spotifyTrackUri,
        set: {
          isrc: sql`excluded.isrc`,
          title: sql`excluded.title`,
          artists: sql`excluded.artists`,
          album: sql`excluded.album`,
          albumArtUrl: sql`excluded.album_art_url`,
          durationMs: sql`excluded.duration_ms`,
          releaseDate: sql`excluded.release_date`,
          explicit: sql`excluded.explicit`,
          genres: sql`excluded.genres`,
          primaryArtistId: sql`excluded.primary_artist_id`,
          canonicalTitle: sql`excluded.canonical_title`,
          versionType: sql`excluded.version_type`,
          songFamilyId: sql`excluded.song_family_id`,
          fetchedAt: new Date(),
        },
      });

    // Replace join rows for this track — simplest correct strategy.
    await db.delete(trackArtists).where(eq(trackArtists.spotifyTrackUri, t.uri));
    if (t.artists.some((a) => a.id)) {
      await db.insert(trackArtists).values(
        t.artists
          .map((a, i) => ({
            spotifyTrackUri: t.uri,
            spotifyArtistId: a.id,
            position: i,
          }))
          .filter((row): row is { spotifyTrackUri: string; spotifyArtistId: string; position: number } => !!row.spotifyArtistId),
      ).onConflictDoNothing();
    }
  }

  // Step 4: duplicate-group rebuild within each touched family.
  const touchedFamilies = Array.from(
    new Set(
      spotifyTracks
        .map((t) => songFamilyId(t.artists[0]?.id ?? null, canonicalTitle(t.name)))
        .filter((f): f is string => !!f),
    ),
  );
  for (const family of touchedFamilies) {
    await reassignDuplicateGroups(family);
  }

  if (opts.skipExternal) return;

  // Step 5: warm ReccoBeats cache (own DB write inside getCachedAudioFeatures).
  try {
    await getCachedAudioFeatures(uris);
  } catch (err) {
    console.warn('[enrichment] reccobeats failed', err);
  }

  // Step 6: MusicBrainz by ISRC (rate-limited 1/s internally).
  for (const t of spotifyTracks) {
    const isrc = t.external_ids?.isrc;
    if (!isrc) continue;
    try {
      await enrichMusicBrainz(t.uri, isrc);
    } catch (err) {
      console.warn('[enrichment] musicbrainz failed', t.uri, err);
    }
  }

  // Step 7: similars for top-rated tracks only.
  for (const t of spotifyTracks) {
    const rating = ratingByUri.get(t.uri);
    if (rating === undefined || rating < SIMILARS_RATING_THRESHOLD) continue;
    try {
      await enrichSimilars(accessToken, t);
    } catch (err) {
      console.warn('[enrichment] similars failed', t.uri, err);
    }
  }
}

function parseReleaseDate(s: string | undefined): string | null {
  if (!s) return null;
  // Spotify returns "YYYY", "YYYY-MM", or "YYYY-MM-DD"; pad to a valid SQL date.
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

export interface FamilyRow {
  uri: string;
  isrc: string | null;
  durationMs: number | null;
  versionType: string | null;
  duplicateGroupId: string | null;
}

/**
 * Pure: given all rows in a song family, compute the desired
 * `duplicate_group_id` for each URI. Returns only the URIs whose value
 * changes — keeps the DB writes minimal.
 *
 * Group key = lexicographically smallest URI in the cluster (stable across
 * reruns). Solo clusters get null.
 */
export function computeDuplicateGroups(rows: FamilyRow[]): Map<string, string | null> {
  const updates = new Map<string, string | null>();
  if (rows.length < 2) {
    // A family of size 1 can still need its own duplicate_group_id cleared.
    for (const r of rows) {
      if (r.duplicateGroupId !== null) updates.set(r.uri, null);
    }
    return updates;
  }

  const parent: number[] = rows.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (
        isApparentDuplicate(
          { isrc: rows[i].isrc, durationMs: rows[i].durationMs, versionType: (rows[i].versionType ?? 'original') as VersionType },
          { isrc: rows[j].isrc, durationMs: rows[j].durationMs, versionType: (rows[j].versionType ?? 'original') as VersionType },
        )
      ) union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  for (const members of clusters.values()) {
    const desired = members.length >= 2 ? members.map((m) => rows[m].uri).sort()[0] : null;
    for (const m of members) {
      if (rows[m].duplicateGroupId !== desired) updates.set(rows[m].uri, desired);
    }
  }
  return updates;
}

/**
 * Within a song family, recompute duplicate clusters and persist any
 * `duplicate_group_id` changes.
 */
export async function reassignDuplicateGroups(family: string): Promise<void> {
  const rows = await db
    .select({
      uri: tracks.spotifyTrackUri,
      isrc: tracks.isrc,
      durationMs: tracks.durationMs,
      versionType: tracks.versionType,
      duplicateGroupId: tracks.duplicateGroupId,
    })
    .from(tracks)
    .where(eq(tracks.songFamilyId, family));

  const updates = computeDuplicateGroups(rows);
  for (const [uri, desired] of updates) {
    await db
      .update(tracks)
      .set({ duplicateGroupId: desired })
      .where(eq(tracks.spotifyTrackUri, uri));
  }
}

async function enrichMusicBrainz(uri: string, isrc: string): Promise<void> {
  const rec = await fetchRecordingByIsrc(isrc);
  if (!rec) return;

  await db
    .insert(trackWorks)
    .values({
      spotifyTrackUri: uri,
      recordingMbid: rec.recordingMbid,
      workMbid: rec.workMbid,
      workAttributes: rec.workAttributes,
    })
    .onConflictDoUpdate({
      target: trackWorks.spotifyTrackUri,
      set: {
        recordingMbid: sql`excluded.recording_mbid`,
        workMbid: sql`excluded.work_mbid`,
        workAttributes: sql`excluded.work_attributes`,
        fetchedAt: new Date(),
      },
    });

  // Recording-level credits.
  const allCredits = [...rec.credits];

  // Work-level credits (composer/lyricist) — one more MB call.
  if (rec.workMbid) {
    const workCredits = await fetchWorkCredits(rec.workMbid);
    allCredits.push(...workCredits);
  }

  if (allCredits.length > 0) {
    await db
      .insert(trackCredits)
      .values(
        allCredits.map((c) => ({
          spotifyTrackUri: uri,
          personMbid: c.personMbid,
          personName: c.personName,
          role: c.role,
          provider: 'musicbrainz',
        })),
      )
      .onConflictDoNothing();
  }
}

async function enrichSimilars(accessToken: string, t: SpotifyTrack): Promise<void> {
  const artist = t.artists[0]?.name;
  if (!artist) return;
  const similars = await fetchSimilarTracks(artist, t.name, 30);
  if (similars.length === 0) return;

  const resolved: Array<{ track: SpotifyTrack; match: number }> = [];
  for (const s of similars) {
    const track = await searchTrack(accessToken, s.artist, s.title);
    if (track) resolved.push({ track, match: s.matchScore });
  }
  if (resolved.length === 0) return;

  // Persist a minimal tracks row for each similar: discovery-mode dedupe
  // (ISRC vs the user's ratings) and hard filters (explicit, artist) need this
  // metadata at candidate-load time, when no Spotify IO is allowed.
  await db
    .insert(tracks)
    .values(
      resolved.map(({ track: s }) => ({
        spotifyTrackUri: s.uri,
        isrc: s.external_ids?.isrc ?? null,
        title: s.name,
        artists: s.artists.map((a) => a.name),
        album: s.album?.name ?? null,
        albumArtUrl: largestAlbumArtUrl(s),
        durationMs: s.duration_ms,
        explicit: s.explicit ?? null,
        primaryArtistId: s.artists[0]?.id ?? null,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(trackSimilars)
    .values(
      resolved.map((r) => ({
        spotifyTrackUri: t.uri,
        similarUri: r.track.uri,
        matchScore: r.match,
      })),
    )
    .onConflictDoNothing();
}

// Exported for tests.
export const __test = {
  parseReleaseDate,
  unenrichedUrisForUser,
  SIMILARS_RATING_THRESHOLD,
};

// Suppress unused-import warning for idFromUri (we re-export for callers).
export { idFromUri };
