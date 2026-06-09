import { test, expect } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  seedLibrary,
  cleanupLibrary,
  seedHistoryPlays,
  cleanupHistoryPlays,
  HISTORY_UNRATED_TITLE,
  getRating,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';

// History view: recent plays the user hasn't rated. With no Spotify token on the
// seeded user, the view degrades to the local `plays` log — deterministic, no
// Spotify mocking needed. Auth via the seeded-user signed cookie (same as the
// library/rating specs).

let unratedUri = '';

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await seedTestUser(userId, testSpotifyId(workerIndex));
  await seedLibrary(userId, workerIndex);
  ({ unratedUri } = await seedHistoryPlays(userId, workerIndex));
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
  await cleanupHistoryPlays(workerIndex);
  await cleanupLibrary(workerIndex);
  await teardownTestUser(testUserId(workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('defaults to unrated plays and hides already-rated tracks', async ({ page }) => {
  await page.goto('/history');

  // The unrated recent track is shown…
  await expect(page.getByText(HISTORY_UNRATED_TITLE)).toBeVisible();
  // …and the rated library track ("Midnight City") is filtered out by default.
  await expect(page.getByText('Midnight City')).toHaveCount(0);
  await expect(page.getByTestId('history-row')).toHaveCount(1);
});

test('nav badge shows the unrated count', async ({ page }) => {
  await page.goto('/history');
  // Layout fetches the count on mount; one unrated track → badge "1".
  await expect(page.getByLabel('1 unrated')).toBeVisible();
});

test('All tab reveals rated tracks', async ({ page }) => {
  await page.goto('/history');
  // Wait for the page to hydrate (content visible) before interacting.
  await expect(page.getByText(HISTORY_UNRATED_TITLE)).toBeVisible();
  await page.getByTestId('history-tab-all').click();

  await expect(page.getByText('Midnight City')).toBeVisible();
  await expect(page.getByText(HISTORY_UNRATED_TITLE)).toBeVisible();
  await expect(page.getByTestId('history-row')).toHaveCount(2);
});

test('rating a track inline removes it from the unrated view and persists', async ({ page }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await page.goto('/history');

  const row = page.getByTestId('history-row').filter({ hasText: HISTORY_UNRATED_TITLE });
  await expect(row).toBeVisible();

  // Click the centre of the star slider → 3 stars.
  await row.getByRole('slider', { name: 'Rating' }).click();

  // Row slides out of the Unrated view, badge clears, and the rating persists.
  await expect(page.getByText(HISTORY_UNRATED_TITLE)).toHaveCount(0);
  await expect(page.getByLabel(/unrated/)).toHaveCount(0);
  await expect.poll(() => getRating(userId, unratedUri)).toBe(3);
});
