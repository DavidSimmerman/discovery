import { test, expect } from '@playwright/test';

test('shuffle on /now-playing plays then advances', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/now-playing');
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByLabel(/^pause$/i)).toBeVisible({ timeout: 20_000 });
  const firstTitle = await page.locator('[data-track-uri]').first().getAttribute('data-track-uri');
  await page.getByLabel(/next track/i).click();
  await expect.poll(
    async () => page.locator('[data-track-uri]').first().getAttribute('data-track-uri'),
    { timeout: 15_000 },
  ).not.toBe(firstTitle);
});
