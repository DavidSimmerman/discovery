import { test, expect, type APIRequestContext } from '@playwright/test';
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

// Preset endpoints over the real DB (shuffle_presets cascades on user delete,
// so no extra cleanup). API-level: the preset UI ships after its own mockup
// round — these tests pin the contract it will sit on.

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

async function getSettings(request: APIRequestContext) {
  const res = await request.get('/api/shuffle/settings');
  expect(res.ok()).toBe(true);
  return (await res.json()).settings;
}

test('create → list → apply round-trips the settings blob', async ({ page }) => {
  const request = page.request;

  // Bake a distinctive settings blob into a preset.
  const settings = await getSettings(request);
  settings.sources.discovery = true;
  settings.sampler.discovery = { pct: 35 };
  settings.filters.allowExplicit = false;
  const created = await request.post('/api/shuffle/presets', {
    data: { name: 'Adventurous', settings },
  });
  expect(created.status()).toBe(201);
  const { preset } = await created.json();
  expect(preset.name).toBe('Adventurous');

  // Listed.
  const list = await (await request.get('/api/shuffle/presets')).json();
  expect(list.presets.map((p: { name: string }) => p.name)).toContain('Adventurous');

  // Mangle the live settings, then apply the preset → blob restored.
  settings.sources.discovery = false;
  settings.sampler.discovery = { pct: 0 };
  await request.put('/api/shuffle/settings', { data: { settings } });

  const applied = await request.post(`/api/shuffle/presets/${preset.id}/apply`);
  expect(applied.ok()).toBe(true);
  const restored = (await applied.json()).settings;
  expect(restored.sources.discovery).toBe(true);
  expect(restored.sampler.discovery).toEqual({ pct: 35 });
  expect(restored.filters.allowExplicit).toBe(false);

  // And the server-side saved settings agree.
  const reloaded = await getSettings(request);
  expect(reloaded.sampler.discovery).toEqual({ pct: 35 });
});

test('duplicate names 409, rename works, delete 404s the second time', async ({ page }) => {
  const request = page.request;

  const first = await request.post('/api/shuffle/presets', { data: { name: 'Gym' } });
  expect(first.status()).toBe(201);
  const { preset } = await first.json();

  const dup = await request.post('/api/shuffle/presets', { data: { name: 'Gym' } });
  expect(dup.status()).toBe(409);

  const renamed = await request.put(`/api/shuffle/presets/${preset.id}`, {
    data: { name: 'Gym (loud)' },
  });
  expect(renamed.ok()).toBe(true);
  expect((await renamed.json()).preset.name).toBe('Gym (loud)');

  const del = await request.delete(`/api/shuffle/presets/${preset.id}`);
  expect(del.ok()).toBe(true);
  const again = await request.delete(`/api/shuffle/presets/${preset.id}`);
  expect(again.status()).toBe(404);
});

test('dropdown UI: save-as, apply restores settings, rename, delete', async ({ page }) => {
  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');

  // Save the current settings as a preset from the pill menu.
  await page.getByTestId('preset-pill').click();
  await page.getByTestId('preset-save-as').click();
  await page.getByTestId('preset-name-input').fill('Defaults');
  await page.getByTestId('preset-name-save').click();
  await expect(page.getByTestId('preset-pill')).toContainText('Defaults');

  // Mutate something (allow explicit off → distinctive blob) and let it save.
  // The manual save unlinks the preset: pill falls back to the generic label.
  await page.getByTestId('preset-pill').click(); // close menu
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/shuffle/settings') && r.request().method() === 'PUT' && r.ok(),
  );
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByTestId('filter-explicit').click();
  await expect(page.getByTestId('filter-explicit')).toHaveAttribute('aria-checked', 'false');
  await saved;
  await expect(page.getByTestId('preset-pill')).toContainText('Presets');

  // Apply the preset → explicit flips back on.
  await page.getByTestId('preset-pill').click();
  await page.getByTestId('preset-row').filter({ hasText: 'Defaults' }).click();
  await expect(page.getByTestId('filter-explicit')).toHaveAttribute('aria-checked', 'true');

  // Rename via the row's ⋯ actions.
  await page.getByTestId('preset-pill').click();
  await page.getByTestId('preset-actions').click();
  await page.getByTestId('preset-rename').click();
  await page.getByTestId('preset-name-input').fill('Stock');
  await page.getByTestId('preset-name-save').click();
  await expect(page.getByTestId('preset-row').filter({ hasText: 'Stock' })).toBeVisible();
  await expect(page.getByTestId('preset-pill')).toContainText('Stock');

  // Delete — pill falls back to the generic label.
  await page.getByTestId('preset-actions').click();
  await page.getByTestId('preset-delete').click();
  await expect(page.getByTestId('preset-row')).toHaveCount(0);
  await expect(page.getByTestId('preset-pill')).toContainText('Presets');

  // And the pill survives a reload without the preset (session FK nulled).
  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('preset-pill')).toContainText('Presets');
});

test('pill shows the applied preset after a reload', async ({ page }) => {
  const created = await page.request.post('/api/shuffle/presets', { data: { name: 'Morning' } });
  expect(created.status()).toBe(201);
  const { preset } = await created.json();
  expect((await page.request.post(`/api/shuffle/presets/${preset.id}/apply`)).ok()).toBe(true);

  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('preset-pill')).toContainText('Morning');
});

test("another user's preset is invisible: apply/rename/delete all 404", async ({ browser }) => {
  const workerIndex = test.info().workerIndex;
  // Owner creates a preset.
  const ownerCtx = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  await ownerCtx.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(workerIndex)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  const created = await ownerCtx.request.post('/api/shuffle/presets', {
    data: { name: 'Private' },
  });
  expect(created.status()).toBe(201);
  const { preset } = await created.json();

  // A second user can't touch it.
  const otherId = testUserId(workerIndex + 50);
  await seedTestUser(otherId, testSpotifyId(workerIndex + 50));
  const otherCtx = await browser.newContext({ baseURL: 'http://127.0.0.1:5173' });
  await otherCtx.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(otherId),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  try {
    expect((await otherCtx.request.post(`/api/shuffle/presets/${preset.id}/apply`)).status()).toBe(404);
    expect(
      (await otherCtx.request.put(`/api/shuffle/presets/${preset.id}`, { data: { name: 'Mine' } })).status(),
    ).toBe(404);
    expect((await otherCtx.request.delete(`/api/shuffle/presets/${preset.id}`)).status()).toBe(404);
  } finally {
    await teardownTestUser(otherId);
    await ownerCtx.close();
    await otherCtx.close();
  }
});
