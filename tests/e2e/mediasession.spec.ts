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
import { mockSpotifySdk, emitSdkState } from './mocks/spotify-sdk';

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

test('mediaSession title is "4★ Track Name" when rated 4 stars', async ({ page }) => {
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/spotify/player/play', (r) => r.fulfill({ status: 204 }));
  // Pre-stage the rating fetch the now-playing page does on track change.
  await page.route('**/api/ratings?uri=*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ratingStars: 4 }) }),
  );

  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').click();
  await emitSdkState(page, {
    track: {
      uri: 'spotify:track:mock1',
      name: 'My Track',
      artists: [{ name: 'A' }],
      album: { name: 'Alb', images: [] },
    },
  });

  // Wait for the rating fetch to complete and mediaSession to update.
  await page.waitForFunction(() => {
    const t = navigator.mediaSession?.metadata?.title ?? '';
    return t.startsWith('4★');
  });

  const title = await page.evaluate(() => navigator.mediaSession?.metadata?.title ?? '');
  expect(title).toBe('4★ My Track');
});
