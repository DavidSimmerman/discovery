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

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'free');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(w)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
});

test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('PremiumGate blocks play for non-premium users', async ({ page }) => {
  // Track if the play API was called.
  let playCalled = false;
  await page.route('**/api/spotify/player/play', async (route) => {
    playCalled = true;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/api/spotify/player/transfer', (r) => r.fulfill({ status: 204 }));

  // Navigate to library and wait for it to load.
  await page.goto('/library');
  await page.waitForLoadState('networkidle');

  // Assert "Premium required" text is visible.
  await expect(page.getByText(/Premium required to play in disccovery/i)).toBeVisible();

  // Try clicking the wrapped shuffle button (force-click since it's inside pointer-events:none).
  const shuffleButton = page.getByRole('button', { name: /shuffle/i }).first();
  if (await shuffleButton.isVisible()) {
    await shuffleButton.click({ force: true });
    await page.waitForTimeout(500);
    // Assert playCalled remains false.
    expect(playCalled).toBe(false);
  }
});
