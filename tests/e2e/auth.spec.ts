import { test, expect } from '@playwright/test';

// Logged-out landing + redirect smoke. Full callback round-trip requires a real
// Spotify account and is left as a manual smoke per the plan.

test('logged-out landing shows login button', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /log in with spotify/i })).toBeVisible();
});

test('/auth/login redirects to spotify accounts', async ({ page }) => {
  const resp = await page.request.get('/auth/login', { maxRedirects: 0 });
  expect(resp.status()).toBe(302);
  const loc = resp.headers()['location'];
  expect(loc).toMatch(/^https:\/\/accounts\.spotify\.com\/authorize/);
  expect(loc).toMatch(/code_challenge_method=S256/);
  expect(loc).toMatch(/code_challenge=[A-Za-z0-9_-]+/);
});

test('/auth/callback without PKCE cookie 400s', async ({ page }) => {
  const resp = await page.request.get('/auth/callback?code=fake', { maxRedirects: 0 });
  expect(resp.status()).toBe(400);
});
