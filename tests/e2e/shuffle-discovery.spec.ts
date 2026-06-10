import { test, expect, type Page } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  seedLibrary,
  cleanupLibrary,
  seedSimilars,
  cleanupSimilars,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';

// Discovery mode — real settings/preview-count endpoints over a seeded
// track_similars pool. Library fixture = 4 rated tracks; similars fixture
// nets 2 unheard discovery tracks (see seedSimilars for the exclusion cases).

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await seedTestUser(userId, testSpotifyId(workerIndex));
  await seedLibrary(userId, workerIndex);
  await seedSimilars(workerIndex);
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
  await cleanupSimilars(workerIndex);
  await cleanupLibrary(workerIndex);
  await teardownTestUser(testUserId(workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

function settingsSaved(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/api/shuffle/settings') && r.request().method() === 'PUT' && r.ok(),
  );
}

test('discovery source adds the unheard-similars pool to the count and persists', async ({
  page,
}) => {
  await page.goto('/shuffle-settings');
  const cta = page.getByTestId('shuffle-cta');
  await expect(cta).toContainText('Shuffle 4 songs');

  // The card knows its pool size (excluded similars don't count).
  const card = page.getByTestId('source-discovery');
  await expect(card).toContainText('similar to your favorites · 2');

  const saved = settingsSaved(page);
  await card.click();
  await expect(cta).toContainText('Shuffle 6 songs');
  await saved;

  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 6 songs');
});

test('discovery amount slider: copy tracks pct, zero pulls the pool from the count', async ({
  page,
}) => {
  await page.goto('/shuffle-settings');
  const cta = page.getByTestId('shuffle-cta');
  await expect(cta).toContainText('Shuffle 4 songs');
  await page.getByTestId('source-discovery').click();
  await expect(cta).toContainText('Shuffle 6 songs');

  await page.getByRole('tab', { name: 'Weighting' }).click();
  const label = page.getByTestId('weight-discovery-label');
  await expect(label).toHaveText('~1 in 10 songs'); // stock pct 10

  const slider = page.getByTestId('weight-discovery-pct');
  await slider.press('Home'); // → 0
  await expect(label).toHaveText('off');
  await expect(cta).toContainText('Shuffle 4 songs');

  await slider.press('End'); // → 100
  await expect(label).toHaveText('every song');
  await expect(cta).toContainText('Shuffle 6 songs');
});

test('discovery can be the only source', async ({ page }) => {
  await page.goto('/shuffle-settings');
  const cta = page.getByTestId('shuffle-cta');
  await expect(cta).toContainText('Shuffle 4 songs');

  await page.getByTestId('source-library').click(); // library off
  await expect(cta).toBeDisabled();
  await page.getByTestId('source-discovery').click();
  await expect(cta).toContainText('Shuffle 2 songs');
  await expect(cta).toBeEnabled();
});
