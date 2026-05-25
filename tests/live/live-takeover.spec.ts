import { test, expect } from '@playwright/test';

test.skip(!process.env.LIVE_TAKEOVER, 'Set LIVE_TAKEOVER=1 and start Spotify-elsewhere on a playlist first');

test('takes over the active Spotify context', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/now-playing');
  await expect(page.getByRole('button', { name: /continue in disccovery/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /continue in disccovery/i }).click();
  await expect(page.getByLabel(/^pause$/i)).toBeVisible({ timeout: 15_000 });
});
