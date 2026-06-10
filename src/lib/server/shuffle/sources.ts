// Source-aware candidate loading: turns the user's configured sources
// (discovery library and/or playlists with a rated/unrated/both mode) into the
// flat Candidate[] the sampler consumes.
//
// Split in three layers:
//   prefetchPlaylists — Spotify IO. Call this BEFORE entering the per-user
//     session lock: a cold cache can mean seconds of paginated fetches, which
//     must not hold a DB transaction + advisory lock open.
//   loadCandidates    — DB reads + assembly, safe inside the lock.
//   mergeCandidates   — pure mode/dedupe rules, unit-testable in isolation.

import { inArray, eq } from 'drizzle-orm';
import { ratings, trackLabels, tracks } from '$lib/server/db/schema';
import type { PlaylistTrack } from '$lib/server/spotify';
import { getPlaylistSnapshotCached, getPlaylistTracksCached } from './playlist-cache';
import { applyFilters } from './filters';
import { tierOf, type Candidate } from './sampler';
import type { ShuffleSettings, ShuffleSources, PlaylistSourceMode } from './config';
import type { DbExec } from './session-store';

export type TrackMeta = {
  primaryArtistId: string | null;
  genres: string[] | null;
  versionType: string | null;
  explicit: boolean | null;
};

export type PrefetchedPlaylists = {
  playlists: { mode: PlaylistSourceMode; tracks: PlaylistTrack[] }[];
  skippedPlaylists: string[];
};

// Spotify IO only — resolve snapshot ids and pull track lists (both cached).
// A playlist that fails to load (deleted, scope missing, Spotify hiccup) is
// skipped rather than failing the whole pick — the shuffle degrades to the
// sources that still work. Null token → all playlists skipped.
export async function prefetchPlaylists(
  accessToken: string | null,
  userId: string,
  sources: ShuffleSources,
): Promise<PrefetchedPlaylists> {
  if (accessToken == null) {
    return { playlists: [], skippedPlaylists: sources.playlists.map((p) => p.id) };
  }
  const playlists: PrefetchedPlaylists['playlists'] = [];
  const skippedPlaylists: string[] = [];
  for (const p of sources.playlists) {
    try {
      const snapshotId = await getPlaylistSnapshotCached(accessToken, userId, p.id);
      const plTracks = await getPlaylistTracksCached(accessToken, userId, p.id, snapshotId);
      playlists.push({ mode: p.mode, tracks: plTracks });
    } catch (err) {
      console.error(`shuffle: skipping playlist ${p.id} (${p.name}):`, err);
      skippedPlaylists.push(p.id);
    }
  }
  return { playlists, skippedPlaylists };
}

// Pure merge: library rows + per-playlist track lists → deduped Candidate[].
// - Playlist modes filter against the user's ratings. A track counts as rated
//   by URI match OR by ISRC match — the same recording often lives under
//   several URIs (Spotify relinks, duplicate albums), and the app's rating
//   layer is ISRC-aware, so "Unrated only" must not resurface relinked dupes.
// - Dedupe is by URI; the first candidate wins. Library rows are added first,
//   so a track that's both in the library and a selected playlist keeps its
//   full library metadata.
export function mergeCandidates(args: {
  libraryRows: { uri: string; rating: number | null; meta: TrackMeta }[];
  playlists: { mode: PlaylistSourceMode; tracks: PlaylistTrack[] }[];
  // rating per URI for playlist-mode decisions (library rows carry their own)
  ratingByUri: Map<string, number>;
  // rating per ISRC, for relinked/duplicate URIs of already-rated recordings
  ratingByIsrc?: Map<string, number>;
  // tracks-table metadata for URIs we've seen before (enrichment)
  metaByUri: Map<string, TrackMeta>;
}): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const push = (
    uri: string,
    rating: number | null,
    meta: TrackMeta | null,
    artistIdsFallback: string[],
    explicitFallback: boolean | null,
  ) => {
    if (seen.has(uri)) return;
    seen.add(uri);
    out.push({
      uri,
      tier: tierOf(rating),
      rating,
      artistIds: meta?.primaryArtistId ? [meta.primaryArtistId] : artistIdsFallback,
      genres: meta?.genres ?? [],
      versionType: meta?.versionType ?? null,
      explicit: meta?.explicit ?? explicitFallback,
    });
  };

  for (const r of args.libraryRows) {
    push(r.uri, r.rating, r.meta, [], null);
  }

  for (const p of args.playlists) {
    for (const t of p.tracks) {
      const rating =
        args.ratingByUri.get(t.uri) ??
        (t.isrc != null ? (args.ratingByIsrc?.get(t.isrc) ?? null) : null);
      if (p.mode === 'unrated' && rating != null) continue;
      if (p.mode === 'rated' && rating == null) continue;
      const artistIds = t.artists.map((a) => a.id).filter((id): id is string => id != null);
      push(t.uri, rating, args.metaByUri.get(t.uri) ?? null, artistIds, t.explicit);
    }
  }

  return out;
}

// DB reads + assembly + hard filters. Safe inside the session lock — no
// external IO; the playlist track lists must already be prefetched.
export async function loadCandidates(
  tx: Pick<DbExec, 'select'>,
  userId: string,
  settings: Pick<ShuffleSettings, 'sources' | 'filters'>,
  prefetched: PrefetchedPlaylists,
): Promise<Candidate[]> {
  const { sources, filters } = settings;
  // Library rows (also the rating lookup for playlist modes — one query).
  const ratedRows = await tx
    .select({
      uri: ratings.spotifyTrackUri,
      rating: ratings.ratingStars,
      isrc: ratings.isrc,
      primaryArtistId: tracks.primaryArtistId,
      genres: tracks.genres,
      versionType: tracks.versionType,
      explicit: tracks.explicit,
    })
    .from(ratings)
    .leftJoin(tracks, eq(tracks.spotifyTrackUri, ratings.spotifyTrackUri))
    .where(eq(ratings.userId, userId));

  const ratingByUri = new Map<string, number>();
  const ratingByIsrc = new Map<string, number>();
  for (const r of ratedRows) {
    if (r.rating == null) continue;
    ratingByUri.set(r.uri, r.rating);
    if (r.isrc != null) ratingByIsrc.set(r.isrc, r.rating);
  }

  // Enrichment metadata for playlist tracks we already know (rated or not).
  const playlistUris = [
    ...new Set(prefetched.playlists.flatMap((p) => p.tracks.map((t) => t.uri))),
  ];
  const metaByUri = new Map<string, TrackMeta>();
  if (playlistUris.length > 0) {
    const metaRows = await tx
      .select({
        uri: tracks.spotifyTrackUri,
        primaryArtistId: tracks.primaryArtistId,
        genres: tracks.genres,
        versionType: tracks.versionType,
        explicit: tracks.explicit,
      })
      .from(tracks)
      .where(inArray(tracks.spotifyTrackUri, playlistUris));
    for (const m of metaRows) {
      metaByUri.set(m.uri, {
        primaryArtistId: m.primaryArtistId,
        genres: m.genres,
        versionType: m.versionType,
        explicit: m.explicit,
      });
    }
  }

  const merged = mergeCandidates({
    libraryRows: sources.library
      ? ratedRows.map((r) => ({
          uri: r.uri,
          rating: r.rating,
          meta: {
            primaryArtistId: r.primaryArtistId,
            genres: r.genres,
            versionType: r.versionType,
            explicit: r.explicit,
          },
        }))
      : [],
    playlists: prefetched.playlists,
    ratingByUri,
    ratingByIsrc,
    metaByUri,
  });

  // Label map only when a label filter is active — it's a per-user full scan
  // of track_labels otherwise wasted.
  let labelsByUri = new Map<string, string[]>();
  if (filters.labels.include.length > 0 || filters.labels.exclude.length > 0) {
    const rows = await tx
      .select({ uri: trackLabels.spotifyTrackUri, labelId: trackLabels.labelId })
      .from(trackLabels)
      .where(eq(trackLabels.userId, userId));
    labelsByUri = new Map();
    for (const r of rows) {
      const list = labelsByUri.get(r.uri);
      if (list) list.push(r.labelId);
      else labelsByUri.set(r.uri, [r.labelId]);
    }
  }

  return applyFilters(merged, filters, labelsByUri);
}
