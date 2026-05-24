// Lazily inject the Spotify Web Playback SDK script. Idempotent: repeated calls
// return the same promise. Resolves with the `Spotify` global once the SDK has
// fired `onSpotifyWebPlaybackSDKReady`.

import type {} from './spotify-sdk';

let inflight: Promise<typeof Spotify> | null = null;

export function loadSpotifySdk(): Promise<typeof Spotify> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Spotify SDK only loads in the browser'));
  }
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (inflight) return inflight;

  inflight = new Promise<typeof Spotify>((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = () => {
      if (window.Spotify) resolve(window.Spotify);
      else reject(new Error('Spotify SDK ready event fired but window.Spotify is undefined'));
    };
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.onerror = () => reject(new Error('Failed to load spotify-player.js'));
    document.head.appendChild(script);
  });

  return inflight;
}

// Test-only escape hatch: lets the mocked-SDK Playwright fixture short-circuit
// the loader by pre-populating window.Spotify before the page mounts.
export function __resetSdkLoaderForTests(): void {
  inflight = null;
}
