// Last.fm client — drives Suggested Discovery (track.getSimilar) and provides
// crowd-sourced mood/genre tags (track.getTopTags). Free with an API key.
//
// Last.fm returns artist/title strings (sometimes with MBID), not Spotify URIs.
// Resolving to Spotify URIs is the enrichment worker's job — these functions
// just hit the wire and return what Last.fm gives us.

import { env } from '$env/dynamic/private';
const LASTFM_API_KEY = env.LASTFM_API_KEY ?? '';

const BASE = 'https://ws.audioscrobbler.com/2.0/';

export interface SimilarTrack {
  artist: string;
  title: string;
  mbid: string | null;     // MusicBrainz recording ID, if Last.fm has it
  matchScore: number;      // 0..1
}

export interface TrackTag {
  name: string;
  count: number;           // Last.fm's relative tag weight (0..100)
}

async function call(method: string, params: Record<string, string>): Promise<any> {
  const q = new URLSearchParams({
    method,
    api_key: LASTFM_API_KEY,
    format: 'json',
    ...params,
  });
  const res = await fetch(`${BASE}?${q}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    console.warn(`[lastfm] ${method} ${res.status}`);
    return null;
  }
  const json = await res.json();
  if (json.error) {
    // Last.fm error codes: 6=track not found, 10=invalid api key, 29=rate-limited.
    if (json.error !== 6) console.warn(`[lastfm] ${method} error ${json.error}: ${json.message}`);
    return null;
  }
  return json;
}

/**
 * Fetch up to `limit` similar tracks for a given (artist, title) pair.
 * Returns empty array on any error — Last.fm has thin coverage on indie tracks.
 */
export async function fetchSimilarTracks(
  artist: string,
  title: string,
  limit = 50,
): Promise<SimilarTrack[]> {
  const json = await call('track.getsimilar', {
    artist,
    track: title,
    limit: String(limit),
    autocorrect: '1',
  });
  if (!json?.similartracks?.track) return [];
  const tracks = Array.isArray(json.similartracks.track)
    ? json.similartracks.track
    : [json.similartracks.track];
  return tracks.map((t: any) => ({
    artist: t.artist?.name ?? '',
    title: t.name ?? '',
    mbid: t.mbid || null,
    matchScore: parseFloat(t.match ?? '0') || 0,
  }));
}

export interface ArtistTopTrack {
  title: string;
  playcount: number;
  rank: number; // 1-indexed global-playcount rank
  mbid: string | null; // MusicBrainz recording ID, if Last.fm has it
}

/**
 * Fetch an artist's top tracks, ranked by global Last.fm playcount. This is the
 * "popularity ranking" Spotify removed from its track objects (Feb 2026) — we
 * source the ordering from Last.fm and resolve titles to Spotify URIs elsewhere.
 * Returns up to `limit` entries in rank order; empty array on any error.
 */
export async function fetchArtistTopTracks(
  artist: string,
  limit = 30,
): Promise<ArtistTopTrack[]> {
  const json = await call('artist.gettoptracks', {
    artist,
    limit: String(limit),
    autocorrect: '1',
  });
  if (!json?.toptracks?.track) return [];
  const tracks = Array.isArray(json.toptracks.track)
    ? json.toptracks.track
    : [json.toptracks.track];
  return tracks
    .map((t: any, i: number) => ({
      title: t.name ?? '',
      playcount: parseInt(t.playcount ?? '0', 10) || 0,
      // Last.fm carries the rank in @attr.rank; fall back to array order.
      rank: parseInt(t['@attr']?.rank ?? '', 10) || i + 1,
      mbid: t.mbid || null,
    }))
    .filter((t: ArtistTopTrack) => t.title !== '');
}

/**
 * Fetch crowd-sourced tags for a track. Used as a mood/genre proxy when
 * audio features aren't available.
 */
export async function fetchTrackTags(
  artist: string,
  title: string,
): Promise<TrackTag[]> {
  const json = await call('track.gettoptags', { artist, track: title, autocorrect: '1' });
  if (!json?.toptags?.tag) return [];
  const tags = Array.isArray(json.toptags.tag) ? json.toptags.tag : [json.toptags.tag];
  return tags
    .map((t: any) => ({ name: t.name ?? '', count: parseInt(t.count ?? '0', 10) || 0 }))
    .filter((t: TrackTag) => t.name);
}
