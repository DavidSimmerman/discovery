import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveSourceTrack } from '$lib/server/track-versions';
import { findCoverRecordings } from '$lib/server/musicbrainz';
import { getValidAccessToken } from '$lib/server/tokens';
import { searchTracks } from '$lib/server/spotify';
import { canonicalTitle } from '$lib/song-canonical';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = decodeURIComponent(params.uri);
  if (!uri.startsWith('spotify:track:')) throw error(400, 'invalid track uri');

  const source = await resolveSourceTrack(locals.user.id, uri);
  if (!source || !source.isrc) throw error(404, 'no isrc — cannot look up covers');

  const mbCovers = await findCoverRecordings(source.isrc);
  if (mbCovers.length === 0) return json({ covers: [] });

  // Resolve each MusicBrainz recording to a Spotify track via search. We do
  // these in parallel — Spotify Search is fine concurrently, only MB itself
  // is rate-limited. Cap to 20 to keep search count reasonable.
  const { access_token } = await getValidAccessToken(locals.user.id);
  const targetCanonical = source.canonicalTitle;

  const candidates = await Promise.all(
    mbCovers.slice(0, 20).map(async (rec) => {
      // The MB artist-credit may include "& Friends" or commas — pull the
      // first comma-separated name for a tighter Spotify search.
      const primaryArtist = rec.artistName.split(/[,&]/)[0].trim();
      if (!primaryArtist) return null;
      const q = `track:${rec.title.replace(/["()[\]{}]/g, ' ')} artist:${primaryArtist.replace(/["()[\]{}]/g, ' ')}`;
      const results = await searchTracks(access_token, q, 5);
      // Pick the first result whose canonical title matches and whose first
      // artist matches the MB artist (case-insensitive). Drops Spotify's
      // fuzzy false-positives without losing legitimate matches.
      const targetArtistKey = primaryArtist.toLowerCase();
      const hit = results.find((t) => {
        const canonMatch = canonicalTitle(t.name) === targetCanonical;
        const artistMatch = t.artists.some(
          (a) => a.name.toLowerCase().includes(targetArtistKey) || targetArtistKey.includes(a.name.toLowerCase()),
        );
        return canonMatch && artistMatch;
      });
      return hit ?? null;
    }),
  );

  // Filter: drop nulls, drop the source URI, drop tracks where source's
  // primary artist is also the cover's primary artist (those belong in the
  // same-artist versions list, not covers).
  const sourcePrimaryKey = source.artists[0]?.toLowerCase().trim() ?? '';
  const ratedRows = await db.execute<{ uri: string; rating_stars: number }>(sql`
    SELECT spotify_track_uri AS uri, rating_stars FROM ratings
    WHERE user_id = ${locals.user.id}
  `);
  const ratingByUri = new Map<string, number>(ratedRows.map((r) => [r.uri, r.rating_stars]));

  const seen = new Set<string>([source.uri]);
  const covers = [];
  for (const t of candidates) {
    if (!t) continue;
    if (seen.has(t.uri)) continue;
    seen.add(t.uri);
    const primary = t.artists[0]?.name?.toLowerCase().trim() ?? '';
    if (sourcePrimaryKey && primary === sourcePrimaryKey) continue;
    covers.push({
      uri: t.uri,
      title: t.name,
      artists: t.artists.map((a) => a.name),
      album: t.album.name ?? null,
      albumArtUrl: t.album.images[0]?.url ?? null,
      rating: ratingByUri.get(t.uri) ?? null,
      versionType: null,
    });
  }

  return json({ covers }, { headers: { 'cache-control': 'no-store' } });
};
