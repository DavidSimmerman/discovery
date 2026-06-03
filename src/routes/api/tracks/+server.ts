// Bulk track metadata lookup — { uri → title, artists, album, albumArtUrl }.
// Used by the now-playing tabbed panel's Queue tab to hydrate upcoming URIs
// (the timeline endpoint returns URIs only). Reads from the local `tracks`
// table; a URI not yet enriched returns nulls so the caller can fall back to
// "Track" / "Unknown artist" rather than 404.
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { tracks } from '$lib/server/db/schema';
import { inArray } from 'drizzle-orm';

const MAX_URIS = 50;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const raw = url.searchParams.get('uris');
  if (!raw) return json({ tracks: [] });

  const uris = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (uris.length === 0) return json({ tracks: [] });
  if (uris.length > MAX_URIS) throw error(400, `max ${MAX_URIS} uris`);

  const rows = await db
    .select({
      uri: tracks.spotifyTrackUri,
      title: tracks.title,
      artists: tracks.artists,
      album: tracks.album,
      albumArtUrl: tracks.albumArtUrl,
    })
    .from(tracks)
    .where(inArray(tracks.spotifyTrackUri, uris));

  // Preserve request order so the caller can render items in the order they
  // asked, regardless of DB row order. Missing URIs (un-enriched) yield nulls.
  const byUri = new Map(rows.map((r) => [r.uri, r]));
  const out = uris.map((uri) => {
    const r = byUri.get(uri);
    return {
      uri,
      title: r?.title ?? null,
      artists: r?.artists ?? [],
      album: r?.album ?? null,
      albumArtUrl: r?.albumArtUrl ?? null,
    };
  });
  return json({ tracks: out }, { headers: { 'cache-control': 'no-store' } });
};
