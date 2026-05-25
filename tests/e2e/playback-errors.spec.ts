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

test('premium_required at play time swaps in PremiumGate state', async ({ page }) => {
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));
  await page.route('**/api/spotify/player/play', (r) =>
    r.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'premium_required' }),
    }),
  );

  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByText(/Premium required to play in disccovery/i).first()).toBeVisible();
});
