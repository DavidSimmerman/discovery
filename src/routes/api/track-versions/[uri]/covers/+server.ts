import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveSourceTrack } from '$lib/server/track-versions';
import { findCoverRecordings } from '$lib/server/musicbrainz';
import { getValidAccessToken } from '$lib/server/tokens';
import { searchTracks, type SpotifyTrack } from '$lib/server/spotify';
import { canonicalTitle } from '$lib/song-canonical';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

// Normalize an artist name for set comparison: drop diacritics, lowercase,
// collapse whitespace.
function normArtist(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Split a MusicBrainz artist-credit ("A, B & C feat. D") into individual names.
function splitCredit(credit: string): string[] {
  return credit
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b|\bx\b/i)
    .map(normArtist)
    .filter(Boolean);
}

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = decodeURIComponent(params.uri);
  if (!uri.startsWith('spotify:track:')) throw error(400, 'invalid track uri');

  const source = await resolveSourceTrack(locals.user.id, uri);
  if (!source || !source.isrc) throw error(404, 'no isrc — cannot look up covers');

  const targetCanonical = source.canonicalTitle;
  const sourcePrimaryKey = normArtist(source.artists[0] ?? '');

  // MusicBrainz: every artist who has a recording of this song's work. This is
  // the authoritative allowlist of legitimate covers.
  const mbRecordings = await findCoverRecordings(source.isrc);
  const allowlist = new Set<string>();
  for (const rec of mbRecordings) {
    for (const name of splitCredit(rec.artistName)) allowlist.add(name);
  }

  // For distinctive titles (4+ words) an exact canonical match is a strong
  // enough signal on its own — this catches popular covers MusicBrainz is
  // missing entirely. Short/generic titles ("Hurt") stay gated to the MB
  // allowlist to avoid pulling in unrelated same-title songs.
  const distinctiveTitle = targetCanonical.split(' ').filter(Boolean).length >= 4;

  // No MB match AND not a distinctive title → nothing safe to return.
  if (allowlist.size === 0 && !distinctiveTitle) {
    throw error(404, 'no musicbrainz match');
  }

  // Single title-only Spotify search, ranked by popularity. Far cheaper than
  // resolving each MB recording individually, and surfaces the popular covers.
  const { access_token } = await getValidAccessToken(locals.user.id);
  const sanitized = targetCanonical.replace(/["()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
  let results: SpotifyTrack[];
  try {
    results = await searchTracks(access_token, `track:"${sanitized}"`, 50);
  } catch {
    results = [];
  }

  const ratedRows = await db.execute<{ uri: string; rating_stars: number }>(sql`
    SELECT spotify_track_uri AS uri, rating_stars FROM ratings
    WHERE user_id = ${locals.user.id}
  `);
  const ratingByUri = new Map<string, number>(ratedRows.map((r) => [r.uri, r.rating_stars]));

  const seenArtist = new Set<string>();
  const covers = [];
  for (const t of results) {
    if (t.uri === source.uri) continue;
    if (canonicalTitle(t.name) !== targetCanonical) continue;

    const primaryKey = normArtist(t.artists[0]?.name ?? '');
    if (!primaryKey) continue;
    if (primaryKey === sourcePrimaryKey) continue; // same artist → belongs in versions list
    if (seenArtist.has(primaryKey)) continue;

    const resultArtistKeys = t.artists.map((a) => normArtist(a.name));
    const inAllowlist = resultArtistKeys.some(
      (k) => allowlist.has(k) || [...allowlist].some((a) => a.includes(k) || k.includes(a)),
    );
    if (!inAllowlist && !distinctiveTitle) continue;

    seenArtist.add(primaryKey);
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
