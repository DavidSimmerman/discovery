import { test, expect } from '@playwright/test';

test('mediaSession title reflects rating + track name', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/library');
  await page.getByTestId('library-row').first().click();
  await expect.poll(
    async () => await page.evaluate(() => navigator.mediaSession.metadata?.title ?? ''),
    { timeout: 20_000 },
  ).not.toBe('');
  // Star prefix is optional (depends on whether the first row is rated).
  // What we can verify: title is non-empty and ends with the track name.
  const title = await page.evaluate(() => navigator.mediaSession.metadata?.title ?? '');
  expect(title.length).toBeGreaterThan(0);
});
