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

// Filters tab — runs against the REAL preview-count and filter-options
// endpoints (no Spotify needed: library-only source). Seeded library:
//   M83 5★ [night drive, synth] · deadmau5 4★ [night drive]
//   Dua Lipa 3★ [pop] · Hans Zimmer 2★ []

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await seedTestUser(userId, testSpotifyId(workerIndex));
  await seedLibrary(userId, workerIndex);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(userId),
      url: 'http://127.0.0.1:5173',
    },
  ]);
});

test.afterEach(async () => {
  const workerIndex = test.info().workerIndex;
  await cleanupLibrary(workerIndex);
  await teardownTestUser(testUserId(workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('star range narrows the real preview count', async ({ page }) => {
  await page.goto('/shuffle-settings');
  const cta = page.getByTestId('shuffle-cta');
  await expect(cta).toContainText('Shuffle 4 songs');

  await page.getByRole('tab', { name: 'Filters' }).click();

  // Tap 3★ mid-range → range collapses to 3–3 → only the 3★ track.
  await page.getByTestId('filter-star-3').click();
  await expect(page.getByTestId('filter-rating-range')).toHaveText('3★ – 3★');
  await expect(cta).toContainText('Shuffle 1 song');

  // Extend up to 5★ → 3★..5★ → three tracks.
  await page.getByTestId('filter-star-5').click();
  await expect(page.getByTestId('filter-rating-range')).toHaveText('3★ – 5★');
  await expect(cta).toContainText('Shuffle 3 songs');
});

test('label chips include/exclude against real data and persist', async ({ page }) => {
  await page.goto('/shuffle-settings');
  // Wait for the live count: proves hydration finished so the tab click lands.
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');
  await page.getByRole('tab', { name: 'Filters' }).click();

  const nightDrive = page.getByTestId('filter-label-chip').filter({ hasText: 'night drive' });
  await expect(nightDrive).toBeVisible();

  // include → only the two night-drive tracks
  await nightDrive.click();
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 2 songs');

  // exclude → the other two
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/shuffle/settings') && r.request().method() === 'PUT' && r.ok(),
  );
  await nightDrive.click();
  await expect(nightDrive).toContainText('⊘');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 2 songs');

  // persists across reload
  await saved;
  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 2 songs');
  await page.getByRole('tab', { name: 'Filters' }).click();
  await expect(
    page.getByTestId('filter-label-chip').filter({ hasText: 'night drive' }),
  ).toContainText('⊘');
});

test('unrated mode with a rated-only library disables the shuffle', async ({ page }) => {
  await page.goto('/shuffle-settings');
  // Wait for the live count: proves hydration finished so the tab click lands.
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');
  await page.getByRole('tab', { name: 'Filters' }).click();

  await page.getByTestId('filter-rating').getByRole('button', { name: 'Unrated' }).click();
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 0 songs');
  await expect(page.getByTestId('shuffle-cta')).toBeDisabled();
});
