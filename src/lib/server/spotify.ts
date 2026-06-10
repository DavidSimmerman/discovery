import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from '$env/static/private';
import { PUBLIC_BASE_URL } from '$env/static/public';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/callback`;

// Carries the HTTP status so callers can branch on 403 (insufficient scope)
// vs. transient 5xx without parsing error message strings.
export class SpotifyApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
  }
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;        // seconds
  scope: string;
  token_type: 'Bearer';
}

function basicAuth(): string {
  return 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token refresh failed: ${res.status} ${await res.text()}`);
  }
  // Spotify may or may not return a new refresh_token; if absent, keep the old one.
  const json = await res.json();
  return { ...json, refresh_token: json.refresh_token ?? refreshToken };
}

export async function fetchSpotifyMe(
  accessToken: string,
): Promise<{ id: string; display_name: string | null; email?: string; product: 'premium' | 'free' | 'open' }> {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify /me failed: ${res.status}`);
  return res.json();
}

export interface SpotifyTrack {
  uri: string;
  name: string;
  artists: { name: string; id?: string }[];
  album: {
    name: string;
    images: { url: string; width: number; height: number }[];
    release_date?: string;
    release_date_precision?: 'year' | 'month' | 'day';
  };
  duration_ms: number;
  explicit?: boolean;
  external_ids?: { isrc?: string };
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

export interface CurrentlyPlaying {
  is_playing: boolean;
  progress_ms: number | null;
  item: SpotifyTrack | null;
  context?: { uri: string | null } | null;
}

export async function fetchCurrentlyPlaying(accessToken: string): Promise<CurrentlyPlaying | null> {
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return null; // nothing playing
  if (!res.ok) throw new Error(`Spotify currently-playing failed: ${res.status}`);
  return res.json();
}

export async function fetchTrack(accessToken: string, trackId: string): Promise<SpotifyTrack> {
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Spotify track fetch failed: ${res.status}`);
  return res.json();
}

// Strip the "spotify:track:" / "spotify:artist:" prefix and return the bare id.
export function idFromUri(uri: string): string {
  const m = uri.match(/^spotify:(?:track|artist):(.+)$/);
  return m ? m[1] : uri;
}

// Batch /v1/tracks — up to 50 ids per call. Returns tracks in input order; nulls dropped.
export async function fetchTracks(
  accessToken: string,
  uris: string[],
): Promise<SpotifyTrack[]> {
  if (uris.length === 0) return [];
  const out: SpotifyTrack[] = [];
  for (let i = 0; i < uris.length; i += 50) {
    const ids = uris.slice(i, i + 50).map(idFromUri).join(',');
    const res = await fetch(`https://api.spotify.com/v1/tracks?ids=${ids}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Spotify /tracks failed: ${res.status}`);
    const json = await res.json();
    for (const t of json.tracks ?? []) {
      if (t) out.push(t as SpotifyTrack);
    }
  }
  return out;
}

// Batch /v1/artists — up to 50 ids per call. Returns artists; nulls dropped.
export async function fetchArtists(
  accessToken: string,
  artistIds: string[],
): Promise<SpotifyArtist[]> {
  if (artistIds.length === 0) return [];
  const out: SpotifyArtist[] = [];
  for (let i = 0; i < artistIds.length; i += 50) {
    const ids = artistIds.slice(i, i + 50).join(',');
    const res = await fetch(`https://api.spotify.com/v1/artists?ids=${ids}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Spotify /artists failed: ${res.status}`);
    const json = await res.json();
    for (const a of json.artists ?? []) {
      if (a) out.push({ id: a.id, name: a.name, genres: a.genres ?? [] });
    }
  }
  return out;
}

// Artist top tracks. `market` defaults to 'US' — Spotify requires a market param.
export async function fetchArtistTopTracks(
  accessToken: string,
  artistId: string,
  market = 'US',
): Promise<SpotifyTrack[]> {
  const res = await fetch(
    `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${market}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Spotify artist top-tracks failed: ${res.status}`);
  const json = await res.json();
  return (json.tracks ?? []) as SpotifyTrack[];
}

// User's top artists/tracks. Spotify caps `limit` at 50; we only ever need 50.
// `time_range` defaults to 'long_term' (several years), which is what we want
// for a durable "top artists" view rather than a recency-biased one.
export async function fetchMyTopArtists(
  accessToken: string,
  time_range: 'short_term' | 'medium_term' | 'long_term' = 'long_term',
): Promise<{ id: string; name: string }[]> {
  const url = `https://api.spotify.com/v1/me/top/artists?limit=50&time_range=${time_range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new SpotifyApiError(res.status, `Spotify /me/top/artists failed: ${res.status}`);
  const json = await res.json();
  return ((json.items ?? []) as { id: string; name: string }[]).map((a) => ({
    id: a.id,
    name: a.name,
  }));
}

export async function fetchMyTopTracks(
  accessToken: string,
  time_range: 'short_term' | 'medium_term' | 'long_term' = 'long_term',
): Promise<{ uri: string; name: string }[]> {
  const url = `https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=${time_range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new SpotifyApiError(res.status, `Spotify /me/top/tracks failed: ${res.status}`);
  const json = await res.json();
  return ((json.items ?? []) as { uri: string; name: string }[]).map((t) => ({
    uri: t.uri,
    name: t.name,
  }));
}

export interface RecentlyPlayedItem {
  track: SpotifyTrack;
  played_at: string; // ISO 8601 timestamp of when playback ended
}

// The user's recently-played tracks (GET /me/player/recently-played). Spotify
// caps `limit` at 50 and only returns a rolling window of the most recent plays
// (tracks played for >30s). `afterMs` is a Unix ms cursor — only plays strictly
// after it are returned — so we pass `now - windowMs` to bound the history.
// Returns full track objects (album art + ISRC included) paired with played_at;
// non-track items (local files / podcasts) are filtered out.
export async function fetchRecentlyPlayed(
  accessToken: string,
  afterMs?: number,
  limit = 50,
): Promise<RecentlyPlayedItem[]> {
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, limit))) });
  if (afterMs !== undefined) params.set('after', String(Math.floor(afterMs)));
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/recently-played?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new SpotifyApiError(res.status, `Spotify recently-played failed: ${res.status}`);
  }
  const json = await res.json();
  return ((json.items ?? []) as RecentlyPlayedItem[]).filter(
    (i) => typeof i?.track?.uri === 'string' && i.track.uri.startsWith('spotify:track:'),
  );
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  imageUrl: string | null;
  total: number;
  snapshotId: string;
}

// All of the user's playlists (owned + followed + collaborative), paginated.
// Requires playlist-read-private / playlist-read-collaborative scopes.
export async function fetchMyPlaylists(accessToken: string): Promise<SpotifyPlaylistSummary[]> {
  const out: SpotifyPlaylistSummary[] = [];
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new SpotifyApiError(res.status, `Spotify /me/playlists failed: ${res.status}`);
    const json: {
      next?: string | null;
      items?: {
        id?: string;
        name?: string;
        images?: { url: string }[] | null;
        tracks?: { total?: number } | null;
        snapshot_id?: string;
      }[];
    } = await res.json();
    for (const p of json.items ?? []) {
      if (!p?.id) continue;
      out.push({
        id: p.id,
        name: p.name ?? '',
        imageUrl: p.images?.[0]?.url ?? null,
        total: p.tracks?.total ?? 0,
        snapshotId: p.snapshot_id ?? '',
      });
    }
    url = json.next ?? null;
  }
  return out;
}

export interface PlaylistTrack {
  uri: string;
  name: string;
  artists: { id: string | null; name: string }[];
  explicit: boolean;
  // For ISRC-aware rating matches (Spotify relinks / duplicate album URIs).
  isrc: string | null;
}

// Every playable track in a playlist, paginated 100 at a time. Local files and
// podcast episodes are dropped (no spotify:track: URI → can't rate or shuffle
// them). `fields` trims the payload to what we use.
export async function fetchPlaylistTracks(
  accessToken: string,
  playlistId: string,
): Promise<PlaylistTrack[]> {
  const fields = encodeURIComponent(
    'next,items(track(uri,name,explicit,external_ids(isrc),artists(id,name)))',
  );
  const out: PlaylistTrack[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=${fields}`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new SpotifyApiError(res.status, `Spotify playlist tracks failed: ${res.status}`);
    }
    const json: {
      next?: string | null;
      items?: {
        track?: {
          uri?: string;
          name?: string;
          explicit?: boolean;
          external_ids?: { isrc?: string } | null;
          artists?: { id?: string; name?: string }[];
        } | null;
      }[];
    } = await res.json();
    for (const item of json.items ?? []) {
      const t = item?.track;
      if (!t?.uri || !t.uri.startsWith('spotify:track:')) continue;
      out.push({
        uri: t.uri,
        name: t.name ?? '',
        artists: (t.artists ?? []).map((a: { id?: string; name?: string }) => ({
          id: a.id ?? null,
          name: a.name ?? '',
        })),
        explicit: Boolean(t.explicit),
        isrc: t.external_ids?.isrc ?? null,
      });
    }
    url = json.next ?? null;
  }
  return out;
}

// Resolve a Last.fm (artist, title) pair to a Spotify track via /v1/search.
// Returns the full track object — callers persist its isrc/metadata, not just
// the URI — or null when nothing plausible matches.
export async function searchTrack(
  accessToken: string,
  artist: string,
  title: string,
): Promise<SpotifyTrack | null> {
  const q = `track:"${title.replace(/"/g, '')}" artist:"${artist.replace(/"/g, '')}"`;
  const url = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const json = await res.json();
  return (json.tracks?.items?.[0] as SpotifyTrack | undefined) ?? null;
}

// Multi-result search. `query` is a raw Spotify search expression — the caller
// builds it (e.g. `track:"..." artist:"..."` for an artist-scoped search, or
// just `track:"..."` to surface cross-artist results).
//
// NOTE: Spotify's search `limit` is capped at 10 — anything higher returns
// `400 Invalid limit`. We clamp here so callers can't silently zero out their
// results by asking for more.
export const SEARCH_LIMIT_MAX = 10;

export async function searchTracks(
  accessToken: string,
  query: string,
  limit = SEARCH_LIMIT_MAX,
): Promise<SpotifyTrack[]> {
  const clamped = Math.max(1, Math.min(SEARCH_LIMIT_MAX, limit));
  const url = `https://api.spotify.com/v1/search?type=track&limit=${clamped}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  const json = await res.json();
  return ((json.tracks?.items ?? []) as SpotifyTrack[]).filter(Boolean);
}
