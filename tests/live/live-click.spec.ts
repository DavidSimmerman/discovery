import { test, expect } from '@playwright/test';

test('clicking a row plays it via real SDK', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/library');
  const row = page.getByTestId('library-row').first();
  await expect(row).toBeVisible();
  const uri = await row.getAttribute('data-uri');
  await row.click();
  // The mini-player appears once player_state_changed fires.
  await expect(page.getByLabel(/open now playing/i)).toBeVisible({ timeout: 15_000 });
  await page.getByLabel(/open now playing/i).click();
  // /now-playing should show the same URI.
  await expect(page.locator(`[data-track-uri="${uri}"]`)).toBeVisible({ timeout: 5_000 });
});
