// Listening-history view: recently-played tracks the user hasn't rated yet.
//
// Two sources are merged so a song surfaces whether it was played inside
// disccovery OR on Spotify directly (phone, desktop, another device):
//   1. Spotify  — GET /me/player/recently-played (rolling last-50 window).
//   2. In-app   — the local `plays` log (deeper history, every shuffle/manual pick).
//
// Plays are deduped to one row per track (most recent play wins, with a combined
// play count). Each row's rating is resolved by URI first, then by ISRC fallback
// (Spotify serves the same recording under different URIs), so a track rated
// under a sibling URI correctly shows as already-rated. The default view filters
// to unrated; `includeRated` returns everything so ratings can be revisited.

import { db } from '$lib/server/db';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import {
  plays as playsTable,
  ratings,
  tracks as tracksTable,
  users,
} from '$lib/server/db/schema';
import { fetchRecentlyPlayed, SpotifyApiError } from '$lib/server/spotify';
import { largestAlbumArtUrl } from '$lib/server/tracks';

// Default lookback for the history view + badge count.
export const HISTORY_WINDOW_DAYS = 7;

const DAY_MS = 86_400_000;

export type HistorySource = 'spotify' | 'discovery' | 'both';

export type HistoryRow = {
  uri: string;
  title: string | null;
  artists: string[];
  albumArtUrl: string | null;
  album: string | null;
  // ISRC of the recording (when known). Lets the client collapse sibling URIs
  // for the same recording — rating one rates all of them (ratings dedupe by ISRC).
  isrc: string | null;
  rating: number | null;
  // ISO timestamp of the most recent play across both sources.
  playedAt: string;
  playedAtMs: number;
  // Combined number of plays seen in the window (Spotify + in-app).
  playCount: number;
  source: HistorySource;
};

export type TrackMeta = {
  title: string | null;
  artists: string[];
  albumArtUrl: string | null;
  album: string | null;
  isrc: string | null;
};

type RawPlay = { uri: string; playedAtMs: number; source: 'spotify' | 'discovery' };

/**
 * Pure merge step (no I/O) so the dedupe / counting / rating-resolution / sort
 * logic is unit-testable. Dedupes `plays` by URI keeping the latest play and a
 * combined count, attaches cached metadata, resolves a rating via URI then ISRC,
 * computes the unrated count over the full set, and returns the (optionally
 * unrated-filtered) rows newest-first.
 */
export function mergeHistory(
  plays: RawPlay[],
  meta: Map<string, TrackMeta>,
  ratingByUri: Map<string, number>,
  ratingByIsrc: Map<string, number>,
  opts: { includeRated: boolean },
): { rows: HistoryRow[]; unratedCount: number } {
  const agg = new Map<
    string,
    { lastMs: number; count: number; spotify: boolean; discovery: boolean }
  >();
  for (const p of plays) {
    const e = agg.get(p.uri);
    if (e) {
      if (p.playedAtMs > e.lastMs) e.lastMs = p.playedAtMs;
      e.count += 1;
      if (p.source === 'spotify') e.spotify = true;
      else e.discovery = true;
    } else {
      agg.set(p.uri, {
        lastMs: p.playedAtMs,
        count: 1,
        spotify: p.source === 'spotify',
        discovery: p.source === 'discovery',
      });
    }
  }

  const all: HistoryRow[] = [];
  for (const [uri, e] of agg) {
    const m = meta.get(uri);
    const isrc = m?.isrc ?? null;
    const rating =
      ratingByUri.get(uri) ?? (isrc != null ? ratingByIsrc.get(isrc) : undefined) ?? null;
    all.push({
      uri,
      title: m?.title ?? null,
      artists: m?.artists ?? [],
      albumArtUrl: m?.albumArtUrl ?? null,
      album: m?.album ?? null,
      isrc,
      rating,
      playedAt: new Date(e.lastMs).toISOString(),
      playedAtMs: e.lastMs,
      playCount: e.count,
      source: e.spotify && e.discovery ? 'both' : e.spotify ? 'spotify' : 'discovery',
    });
  }

  const unratedCount = all.filter((r) => r.rating == null).length;
  const rows = (opts.includeRated ? all : all.filter((r) => r.rating == null)).sort(
    (a, b) => b.playedAtMs - a.playedAtMs || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0),
  );

  return { rows, unratedCount };
}

/**
 * Build the user's recent listening history. `accessToken` is best-effort: when
 * null or Spotify is unavailable, the view degrades to in-app plays only rather
 * than failing. `unratedCount` always reflects the full window (the nav badge),
 * independent of the `includeRated` filter on the returned rows.
 */
export async function listHistory(
  userId: string,
  accessToken: string | null,
  opts: { includeRated?: boolean; windowDays?: number } = {},
): Promise<{ rows: HistoryRow[]; unratedCount: number }> {
  const windowDays = opts.windowDays ?? HISTORY_WINDOW_DAYS;
  const cutoffMs = Date.now() - windowDays * DAY_MS;
  const cutoff = new Date(cutoffMs);

  // 1. Spotify recently-played (catches plays outside disccovery). Best-effort.
  let spotifyItems: Awaited<ReturnType<typeof fetchRecentlyPlayed>> = [];
  if (accessToken) {
    try {
      spotifyItems = await fetchRecentlyPlayed(accessToken, cutoffMs);
    } catch (err) {
      // A 403 means the stored token predates the user-read-recently-played
      // scope — flag the user for re-auth (matching the top-lists refresh) so
      // the next navigation bounces them through OAuth, instead of silently
      // degrading to in-app plays forever. Other failures just degrade.
      if (err instanceof SpotifyApiError && err.status === 403) {
        try {
          await db.update(users).set({ needsReauth: true }).where(eq(users.id, userId));
        } catch (markErr) {
          console.error('[listHistory] failed to flag user for re-auth', { userId, markErr });
        }
      } else {
        console.error('[listHistory] recently-played fetch failed', { userId, err });
      }
    }
  }

  // 2. Cache metadata for any Spotify-recent track not already known, so it
  //    renders (art/title/artist) and can dedupe by ISRC. onConflictDoNothing:
  //    never clobber enrichment fields on tracks we already have.
  if (spotifyItems.length > 0) {
    const byUri = new Map(spotifyItems.map((i) => [i.track.uri, i.track]));
    await db
      .insert(tracksTable)
      .values(
        [...byUri.values()].map((sp) => ({
          spotifyTrackUri: sp.uri,
          isrc: sp.external_ids?.isrc ?? null,
          title: sp.name,
          artists: sp.artists.map((a) => a.name),
          album: sp.album?.name ?? null,
          albumArtUrl: largestAlbumArtUrl(sp),
          durationMs: sp.duration_ms,
        })),
      )
      .onConflictDoNothing();
  }

  // 3. In-app plays within the window.
  const localRows = await db
    .select({ uri: playsTable.spotifyTrackUri, playedAt: playsTable.playedAt })
    .from(playsTable)
    .where(and(eq(playsTable.userId, userId), gt(playsTable.playedAt, cutoff)));

  // 4. Flatten both sources into raw plays (double-guarding the window bound).
  const plays: RawPlay[] = [
    ...spotifyItems.map((i) => ({
      uri: i.track.uri,
      playedAtMs: Date.parse(i.played_at),
      source: 'spotify' as const,
    })),
    ...localRows.map((r) => ({
      uri: r.uri,
      playedAtMs: r.playedAt.getTime(),
      source: 'discovery' as const,
    })),
  ].filter((p) => Number.isFinite(p.playedAtMs) && p.playedAtMs > cutoffMs);

  const uris = [...new Set(plays.map((p) => p.uri))];
  if (uris.length === 0) return { rows: [], unratedCount: 0 };

  // 5. Catalog metadata for all candidate URIs.
  const metaRows = await db
    .select({
      uri: tracksTable.spotifyTrackUri,
      isrc: tracksTable.isrc,
      title: tracksTable.title,
      artists: tracksTable.artists,
      albumArtUrl: tracksTable.albumArtUrl,
      album: tracksTable.album,
    })
    .from(tracksTable)
    .where(inArray(tracksTable.spotifyTrackUri, uris));
  const meta = new Map<string, TrackMeta>(
    metaRows.map((m) => [
      m.uri,
      {
        title: m.title,
        artists: m.artists ?? [],
        albumArtUrl: m.albumArtUrl,
        album: m.album,
        isrc: m.isrc,
      },
    ]),
  );

  // 6. Ratings — direct by URI, then ISRC fallback for the rest.
  const ratingByUri = new Map<string, number>();
  const directRows = await db
    .select({ uri: ratings.spotifyTrackUri, stars: ratings.ratingStars })
    .from(ratings)
    .where(and(eq(ratings.userId, userId), inArray(ratings.spotifyTrackUri, uris)));
  for (const r of directRows) ratingByUri.set(r.uri, r.stars);

  const candidateIsrcs = [
    ...new Set(
      uris
        .map((u) => meta.get(u)?.isrc)
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  ];
  const ratingByIsrc = new Map<string, number>();
  if (candidateIsrcs.length > 0) {
    const isrcRows = await db
      .select({ isrc: ratings.isrc, stars: ratings.ratingStars })
      .from(ratings)
      .where(
        and(
          eq(ratings.userId, userId),
          isNotNull(ratings.isrc),
          inArray(ratings.isrc, candidateIsrcs),
        ),
      );
    for (const r of isrcRows) if (r.isrc) ratingByIsrc.set(r.isrc, r.stars);
  }

  return mergeHistory(plays, meta, ratingByUri, ratingByIsrc, {
    includeRated: opts.includeRated ?? false,
  });
}
