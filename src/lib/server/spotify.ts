import { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } from '$env/static/private';
import { PUBLIC_BASE_URL } from '$env/static/public';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/callback`;

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

// Resolve a Last.fm (artist, title) pair to a Spotify URI via /v1/search.
// Returns null when nothing plausible matches.
export async function searchTrack(
  accessToken: string,
  artist: string,
  title: string,
): Promise<string | null> {
  const q = `track:"${title.replace(/"/g, '')}" artist:"${artist.replace(/"/g, '')}"`;
  const url = `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const json = await res.json();
  const item = json.tracks?.items?.[0];
  return item?.uri ?? null;
}
