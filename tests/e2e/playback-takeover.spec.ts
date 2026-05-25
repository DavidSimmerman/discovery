import { test, expect } from '@playwright/test';
import {
  seedTestUser, teardownTestUser, closeSeedConnection,
  signSessionCookieValue, SESSION_COOKIE_NAME, testUserId, testSpotifyId,
} from './fixtures/seed';
import { mockSpotifySdk } from './mocks/spotify-sdk';

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: signSessionCookieValue(testUserId(w)),
    url: 'http://127.0.0.1:5173',
  }]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => { await teardownTestUser(testUserId(test.info().workerIndex)); });
test.afterAll(async () => { await closeSeedConnection(); });

test('Continue in disccovery sends context_uri + offset + position', async ({ page }) => {
  await page.route('**/api/spotify/currently-playing', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        playing: {
          uri: 'spotify:track:t',
          name: 'X',
          artists: ['A'],
          album: null,
          albumArtUrl: null,
          durationMs: 100000,
          progressMs: 42000,
          isPlaying: true,
          isrc: null,
          contextUri: 'spotify:playlist:p',
        },
        rating: null,
      }),
    }),
  );
  let body: { context_uri?: string; offset?: { uri?: string }; position_ms?: number } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    body = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /continue in disccovery/i }).click();

  await expect.poll(() => body.context_uri, { timeout: 3000 }).toBe('spotify:playlist:p');
  expect(body.offset?.uri).toBe('spotify:track:t');
  expect(body.position_ms).toBe(42000);
});
