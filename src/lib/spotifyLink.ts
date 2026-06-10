// open.spotify.com track link — opens the Spotify app on mobile (universal
// link) or the web/desktop player otherwise. This is the track *page* link: it
// opens the song so the user can decide what to do; it does NOT trigger
// playback. Returns null for non-track URIs (local files, episodes, etc.).
export function spotifyTrackUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const m = uri.match(/^spotify:track:([A-Za-z0-9]+)$/);
  return m ? `https://open.spotify.com/track/${m[1]}` : null;
}

// Where "Open Spotify" should send the user when we just need the Spotify app
// running (cold-start pending play): the spotify: scheme wakes the native app
// on phones; on desktop the web player is the fastest thing that registers as
// a Connect device. Pure so it's testable; openSpotifyApp applies it.
export function spotifyAppHref(userAgent: string): string {
  return /iPhone|iPad|iPod|Android/i.test(userAgent)
    ? 'spotify://'
    : 'https://open.spotify.com/';
}

export function openSpotifyApp(): void {
  const href = spotifyAppHref(navigator.userAgent);
  if (href.startsWith('spotify:')) {
    // Deep link must navigate the current context — window.open of a custom
    // scheme is popup-blocked or opens a dead tab on iOS.
    location.href = href;
  } else {
    window.open(href, '_blank', 'noopener');
  }
}
