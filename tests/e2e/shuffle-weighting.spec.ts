import { test, expect, type Page } from '@playwright/test';
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

// Weighting tab — soft sampler knobs against the REAL settings endpoint
// (library-only source, same seeded library as shuffle-filters.spec.ts).
// Boost coverage uses labels: seeded tracks carry labels but no artist ids
// or genres, and the label axis is the newest engine path anyway.

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

async function openWeighting(page: Page) {
  await page.goto('/shuffle-settings');
  // Wait for the live count: proves hydration finished so the tab click lands.
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');
  await page.getByRole('tab', { name: 'Weighting' }).click();
}

function settingsSaved(page: Page) {
  return page.waitForResponse(
    (r) => r.url().includes('/api/shuffle/settings') && r.request().method() === 'PUT' && r.ok(),
  );
}

test('tier bars adjust via keyboard and persist', async ({ page }) => {
  await openWeighting(page);

  const tier5 = page.getByTestId('weight-tier-5');
  await expect(tier5).toHaveAttribute('aria-valuenow', '100');

  const saved = settingsSaved(page);
  await tier5.focus();
  await tier5.press('ArrowDown');
  await tier5.press('ArrowDown');
  await expect(tier5).toHaveAttribute('aria-valuenow', '90');
  await saved;

  await openWeighting(page);
  await expect(page.getByTestId('weight-tier-5')).toHaveAttribute('aria-valuenow', '90');
});

test('label boost: add via picker, slide, persist', async ({ page }) => {
  await openWeighting(page);

  await page.getByTestId('boost-labels-add').click();
  const option = page
    .getByTestId('filter-picker-option')
    .filter({ hasText: 'night drive' });
  await option.click();
  await page.getByRole('button', { name: 'Done' }).click();

  const row = page.getByTestId('boost-labels').getByTestId('boost-row');
  await expect(row).toContainText('night drive');
  await expect(row.getByTestId('boost-mult')).toHaveText('1.5×');

  // Max out the slider → 2.0×.
  const saved = settingsSaved(page);
  await row.getByRole('slider', { name: /Boost for/ }).press('End');
  await expect(row.getByTestId('boost-mult')).toHaveText('2.0×');
  await saved;

  await openWeighting(page);
  const reloaded = page.getByTestId('boost-labels').getByTestId('boost-row');
  await expect(reloaded.getByTestId('boost-mult')).toHaveText('2.0×');
  await expect(reloaded).toContainText('night drive');

  // Slider to 0 reads as "never" and comes OUT of the live count: the two
  // night-drive tracks are hard-excluded, leaving the other two.
  await reloaded.getByRole('slider', { name: /Boost for/ }).press('Home');
  await expect(reloaded.getByTestId('boost-mult')).toHaveText('never');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 2 songs');

  // The X removes the boost entirely; the count recovers.
  await reloaded.getByRole('button', { name: /Remove/ }).click();
  await expect(page.getByTestId('boost-labels').getByTestId('boost-row')).toHaveCount(0);
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');
});

test('freshness controls persist', async ({ page }) => {
  await openWeighting(page);

  // Daily cap default: off. Enable it and pick 3×.
  const toggle = page.getByTestId('daily-cap-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  const saved = settingsSaved(page);
  await page.getByTestId('daily-cap-max').selectOption('3');
  await saved;

  await openWeighting(page);
  await expect(page.getByTestId('daily-cap-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('daily-cap-max')).toHaveValue('3');

  // Cooldown select disables with its toggle.
  const countToggle = page.getByTestId('cooldown-count-toggle');
  await expect(page.getByTestId('cooldown-count-n')).toBeEnabled();
  await countToggle.click();
  await expect(page.getByTestId('cooldown-count-n')).toBeDisabled();
});

test('reset restores stock weighting', async ({ page }) => {
  await openWeighting(page);

  // Dirty all three sections (tier weight, a label boost, a gate) and let the
  // debounced save land — otherwise reset === server state and no PUT fires.
  const dirtySaved = settingsSaved(page);
  const tier4 = page.getByTestId('weight-tier-4');
  await tier4.focus();
  await tier4.press('ArrowUp');
  await expect(tier4).toHaveAttribute('aria-valuenow', '75');

  await page.getByTestId('boost-labels-add').click();
  await page.getByTestId('filter-picker-option').filter({ hasText: 'pop' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('boost-labels').getByTestId('boost-row')).toHaveCount(1);
  await page.getByTestId('daily-cap-toggle').click();
  await dirtySaved;

  // Reset → stock everywhere. Match the PUT by body: the dirty edits may still
  // flush a save of their own, and the daily cap flag tells the two apart.
  const resetSaved = page.waitForResponse((r) => {
    if (!r.url().includes('/api/shuffle/settings') || r.request().method() !== 'PUT' || !r.ok())
      return false;
    const body = r.request().postDataJSON() as {
      settings: { sampler: { gates: { dailyCap: { enabled: boolean } } } };
    } | null;
    return body?.settings.sampler.gates.dailyCap.enabled === false;
  });
  await page.getByTestId('weight-reset').click();
  await expect(tier4).toHaveAttribute('aria-valuenow', '70');
  await expect(page.getByTestId('boost-labels').getByTestId('boost-row')).toHaveCount(0);
  await expect(page.getByTestId('daily-cap-toggle')).toHaveAttribute('aria-checked', 'false');
  await resetSaved;

  await openWeighting(page);
  await expect(page.getByTestId('weight-tier-4')).toHaveAttribute('aria-valuenow', '70');
  await expect(page.getByTestId('boost-labels').getByTestId('boost-row')).toHaveCount(0);
});
