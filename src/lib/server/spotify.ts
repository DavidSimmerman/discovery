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
  artists: { name: string }[];
  album: { name: string; images: { url: string; width: number; height: number }[] };
  duration_ms: number;
  external_ids?: { isrc?: string };
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
