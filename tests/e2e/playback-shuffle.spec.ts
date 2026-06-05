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

test('smart shuffle on /now-playing pushes a sampler-built context to Spotify', async ({ page }) => {
  // Car mode: the now-playing "Shuffle my library" button starts the sampler,
  // which builds a virtual timeline from the user's rated library and pushes
  // [current, ...upcoming] to Spotify as a real context (PUT play with uris).
  // It does NOT fetch /api/library (that was the old dumb-shuffle path).
  await page.route('**/api/spotify/currently-playing', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playing: null, rating: null }),
    }),
  );
  let lastBody: { uris?: string[] } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    lastBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').click();
  // The sampler builds from the seeded ratings and pushes a non-empty context.
  await expect.poll(() => lastBody.uris?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
});
