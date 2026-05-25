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

test('shuffle on /library uses current filter', async ({ page }) => {
  let lastBody: { uris?: string[]; device_id?: string } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').first().click();
  await expect.poll(() => lastBody.uris?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
  expect(lastBody.device_id).toBe('mock-device-1');
});

test('shuffle on /now-playing fetches full library and sends non-empty uris', async ({ page }) => {
  // Spotify-elsewhere fixture so the page is in "remote control" mode.
  await page.route('**/api/spotify/currently-playing', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playing: null, rating: null }),
    }),
  );
  let libraryFetched = false;
  await page.route('**/api/library*', async (route) => {
    libraryFetched = true;
    await route.continue();
  });
  let lastBody: { uris?: string[]; device_id?: string } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').click();
  await expect.poll(() => libraryFetched, { timeout: 5000 }).toBe(true);
  await expect.poll(() => lastBody.uris?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
});
