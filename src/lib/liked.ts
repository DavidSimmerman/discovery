// Liked Songs as a pseudo-playlist. Spotify's saved-tracks library isn't a
// playlist (it never appears in /me/playlists), so the shuffle source picker
// injects it under this sentinel id and the playlist-cache layer routes it to
// the /me/tracks fetchers. Real playlist ids are base62 — underscores can't
// collide. Shared by server and client (picker renders the heart tile on it).

export const LIKED_SONGS_ID = '__liked__';
export const LIKED_SONGS_NAME = 'Liked Songs';

export function isLikedSongs(id: string): boolean {
  return id === LIKED_SONGS_ID;
}
