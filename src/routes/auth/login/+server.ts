import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { generatePkce } from '$lib/server/pkce';
import { SPOTIFY_CLIENT_ID } from '$env/static/private';
import { PUBLIC_BASE_URL } from '$env/static/public';

// Playback happens on the user's own Spotify devices (phone, desktop app,
// browser tab) via Spotify Connect — disccovery is a remote control, never
// the audio source. So we don't request the `streaming` scope that the Web
// Playback SDK requires; user-modify-playback-state is enough to control
// whatever device is active.
const SCOPES = [
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-library-read',
  // Mirror 2+ star ratings into Liked Songs (user-initiated via the rating
  // action; checked against /me/library/contains so we never re-add).
  'user-library-modify',
  'user-top-read',
  // Shuffle sources: list the user's own playlists and read their tracks so a
  // playlist can be picked as a shuffle pool (e.g. rate-walking an import).
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

export const GET: RequestHandler = async ({ cookies }) => {
  const { verifier, challenge } = generatePkce();

  cookies.set('disccovery_pkce', verifier, {
    path: '/auth/callback',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 10, // 10 minutes
  });

  const authorize = new URL('https://accounts.spotify.com/authorize');
  authorize.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', `${PUBLIC_BASE_URL}/auth/callback`);
  authorize.searchParams.set('scope', SCOPES);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('code_challenge', challenge);

  throw redirect(302, authorize.toString());
};
