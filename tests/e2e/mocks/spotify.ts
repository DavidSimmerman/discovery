import type { Page } from '@playwright/test';

// --- Interception strategy ---------------------------------------------------
// The SvelteKit *server* (Node process) is what calls api.spotify.com /
// accounts.spotify.com via server-side fetch. Playwright's page.route() only
// intercepts requests made by the *browser*, so it cannot touch those
// server-side calls.
//
// The browser only ever hits same-origin endpoints. So we mock Spotify at the
// browser boundary by fulfilling GET /api/spotify/currently-playing directly
// with a fixture. This stubs the Spotify-dependent READ while leaving the real
// /api/ratings endpoint untouched — so ratings genuinely persist to the test DB
// and reload/DB assertions are meaningful (Option A from the task).

export type CurrentlyPlayingFixture = {
  playing: {
    uri: string;
    name: string;
    artists: string[];
    album: string | null;
    albumArtUrl: string | null;
    durationMs: number;
    progressMs: number | null;
    isPlaying: boolean;
    isrc: string | null;
  } | null;
  rating: number | null;
};

export const FIXTURE_TRACK_URI = 'spotify:track:4cOdK2wGLETKBW3PvgPWqT';

export function trackFixture(rating: number | null = null): CurrentlyPlayingFixture {
  return {
    playing: {
      uri: FIXTURE_TRACK_URI,
      name: 'Test Track Title',
      artists: ['Test Artist'],
      album: 'Test Album',
      albumArtUrl: null,
      durationMs: 210_000,
      progressMs: 42_000,
      isPlaying: true,
      isrc: 'TEST00000001',
    },
    rating,
  };
}

export const emptyFixture: CurrentlyPlayingFixture = { playing: null, rating: null };

/**
 * Registers a browser-side route that fulfills GET /api/spotify/currently-playing
 * with the given fixture. The fixture is read lazily on each request via the
 * getter, so a test can swap the response (e.g. before a reload) by mutating the
 * variable the getter closes over.
 */
export async function mockCurrentlyPlaying(
  page: Page,
  getFixture: () => CurrentlyPlayingFixture,
): Promise<void> {
  await page.route('**/api/spotify/currently-playing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(getFixture()),
    });
  });
}
