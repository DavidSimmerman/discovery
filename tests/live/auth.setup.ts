import { test as setup, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';

const AUTH = '.auth/spotify.json';

setup('authenticate against real Spotify', async ({ page }) => {
  setup.setTimeout(180_000);
  if (existsSync(AUTH) && !process.env.FORCE_REAUTH) {
    setup.skip();
    return;
  }
  mkdirSync('.auth', { recursive: true });

  await page.goto('/');
  await page.getByRole('link', { name: /log in with spotify/i }).click();

  // Hand off to the user. Headed run; user completes OAuth manually.
  // We wait for redirect back to our app (the `/` route after callback).
  await page.waitForURL(/127\.0\.0\.1:5173\/$/, { timeout: 180_000 });
  await expect(page.getByText(/Hi,/i)).toBeVisible();

  await page.context().storageState({ path: AUTH });
});
