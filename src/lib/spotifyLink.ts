// open.spotify.com track link — opens the Spotify app on mobile (universal
// link) or the web/desktop player otherwise. This is the track *page* link: it
// opens the song so the user can decide what to do; it does NOT trigger
// playback. Returns null for non-track URIs (local files, episodes, etc.).
export function spotifyTrackUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const m = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return m ? `https://open.spotify.com/track/${m[1]}` : null;
}
