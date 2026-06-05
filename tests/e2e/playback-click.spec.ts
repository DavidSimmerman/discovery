import { test, expect } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  seedLibrary,
  cleanupLibrary,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk } from './mocks/spotify-sdk';
import { mockCurrentlyPlaying, type CurrentlyPlayingFixture } from './mocks/spotify';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(w)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('clicking a library row opens the track view; Play now plays that track', async ({ page }) => {
  // Intercept the play call so we can inspect the body without hitting Spotify.
  let lastBody: unknown = null;
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));
  // Car mode has no Web Playback SDK — the mini-player reflects whatever
  // /api/spotify/currently-playing reports. Start empty; flip to the played
  // track after Play so the next poll surfaces the mini-player.
  let cp: CurrentlyPlayingFixture = { playing: null, rating: null };
  await mockCurrentlyPlaying(page, () => cp);

  await page.goto('/library');
  const row = page.getByTestId('library-row').first();
  const uri = await row.getAttribute('data-uri');
  expect(uri).toBeTruthy();
  await row.click();

  await expect(page).toHaveURL(/\/library\/track\//);
  await page.getByTestId('track-play-now').click();

  await expect.poll(() => lastBody, { timeout: 3000 }).not.toBeNull();
  const body = lastBody as { uris: string[]; device_id?: string };
  expect(body.uris[0]).toBe(uri);
  // Car mode sends no device_id — Spotify routes to its own active device.
  expect(body.device_id).toBeUndefined();

  // Playback started: currently-playing now reports the track, so the next
  // poll surfaces the persistent mini-player.
  cp = {
    playing: {
      uri: uri!,
      name: 'Mock Track',
      artists: ['X'],
      album: null,
      albumArtUrl: null,
      durationMs: 200_000,
      progressMs: 0,
      isPlaying: true,
      isrc: null,
    },
    rating: null,
  };
  await expect(page.getByLabel(/open now playing/i)).toBeVisible();
});
