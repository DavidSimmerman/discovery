import { db } from '$lib/server/db';
import { tracks } from '$lib/server/db/schema';
import type { SpotifyTrack } from '$lib/server/spotify';

function largestAlbumArtUrl(track: SpotifyTrack): string | null {
  const images = track.album?.images ?? [];
  if (images.length === 0) return null;
  return images.reduce((largest, img) => (img.width > largest.width ? img : largest)).url;
}

export async function upsertTrack(track: SpotifyTrack): Promise<void> {
  const row = {
    spotifyTrackUri: track.uri,
    isrc: track.external_ids?.isrc ?? null,
    title: track.name,
    artists: track.artists.map((a) => a.name),
    album: track.album?.name ?? null,
    albumArtUrl: largestAlbumArtUrl(track),
    durationMs: track.duration_ms,
  };

  await db
    .insert(tracks)
    .values(row)
    .onConflictDoUpdate({
      target: tracks.spotifyTrackUri,
      set: {
        isrc: row.isrc,
        title: row.title,
        artists: row.artists,
        album: row.album,
        albumArtUrl: row.albumArtUrl,
        durationMs: row.durationMs,
        fetchedAt: new Date(),
      },
    });
}
