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
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const MAX_ARTISTS = 30;

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = decodeURIComponent(params.uri);
  if (!uri.startsWith('spotify:track:')) throw error(400, 'invalid track uri');

  const source = await resolveSourceTrack(locals.user.id, uri);
  if (!source || !source.isrc) throw error(404, 'no isrc — cannot look up covers');

  const targetCanonical = source.canonicalTitle;
  const sourcePrimaryKey = normArtist(source.artists[0] ?? '');
  const sanitize = (s: string) => s.replace(/["()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();

  // MusicBrainz: every artist with a recording of this song's work — the
  // authoritative set of legitimate cover artists.
  const mbRecordings = await findCoverRecordings(source.isrc);
  const allowlistKeys = new Set<string>();
  const coverArtistNames: string[] = []; // original-cased, deduped, source excluded
  const seenKey = new Set<string>();
  for (const rec of mbRecordings) {
    for (const name of splitCredit(rec.artistName)) {
      const key = normArtist(name);
      if (!key) continue;
      allowlistKeys.add(key);
      if (key === sourcePrimaryKey || seenKey.has(key)) continue;
      seenKey.add(key);
      coverArtistNames.push(name);
    }
  }

  // 4+ word titles are distinctive enough that an exact canonical match alone
  // is trustworthy — lets popular covers MusicBrainz is missing still surface.
  const distinctiveTitle = targetCanonical.split(' ').filter(Boolean).length >= 4;

  if (allowlistKeys.size === 0 && !distinctiveTitle) {
    throw error(404, 'no musicbrainz match');
  }

  const { access_token } = await getValidAccessToken(locals.user.id);

  // Per-artist resolution: search each cover artist directly so the source
  // artist's many releases don't crowd them out of a single title search.
  const perArtist = await mapLimit(coverArtistNames.slice(0, MAX_ARTISTS), 6, async (name) => {
    const q = `track:"${sanitize(targetCanonical)}" artist:"${sanitize(name)}"`;
    let res: SpotifyTrack[];
    try {
      res = await searchTracks(access_token, q, 5);
    } catch {
      return null;
    }
    const key = normArtist(name);
    return (
      res.find(
        (t) =>
          canonicalTitle(t.name) === targetCanonical &&
          t.artists.some((a) => {
            const ak = normArtist(a.name);
            return ak === key || ak.includes(key) || key.includes(ak);
          }),
      ) ?? null
    );
  });

  // Supplemental title-only search — catches distinctive-title covers that MB
  // doesn't list. Filtered to non-source artists below.
  let titleHits: SpotifyTrack[] = [];
  if (distinctiveTitle) {
    try {
      titleHits = await searchTracks(access_token, `track:"${sanitize(targetCanonical)}"`, 10);
    } catch {
      titleHits = [];
    }
  }

  const ratedRows = await db.execute<{ uri: string; rating_stars: number }>(sql`
    SELECT spotify_track_uri AS uri, rating_stars FROM ratings
    WHERE user_id = ${locals.user.id}
  `);
  const ratingByUri = new Map<string, number>(ratedRows.map((r) => [r.uri, r.rating_stars]));

  const seenArtist = new Set<string>();
  const covers: Array<{
    uri: string;
    title: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    rating: number | null;
    versionType: null;
  }> = [];

  const consider = (t: SpotifyTrack) => {
    if (t.uri === source.uri) return;
    if (canonicalTitle(t.name) !== targetCanonical) return;
    const primaryKey = normArtist(t.artists[0]?.name ?? '');
    if (!primaryKey || primaryKey === sourcePrimaryKey) return;
    if (seenArtist.has(primaryKey)) return;

    const inAllowlist = t.artists.some((a) => {
      const k = normArtist(a.name);
      return allowlistKeys.has(k) || [...allowlistKeys].some((x) => x.includes(k) || k.includes(x));
    });
    if (!inAllowlist && !distinctiveTitle) return;

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
  };

  // MB-backed per-artist hits first (highest confidence), then title-search
  // supplements for anything MB missed.
  for (const t of perArtist) if (t) consider(t);
  for (const t of titleHits) consider(t);

  return json({ covers }, { headers: { 'cache-control': 'no-store' } });
};
