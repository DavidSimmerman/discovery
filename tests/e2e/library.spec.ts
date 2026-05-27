import { test, expect } from '@playwright/test';
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

// Library screen e2e. Same harness as rating/labels specs: OAuth bypassed via an
// injected signed session cookie for a per-worker seeded user. The library does
// NOT call Spotify, so there's no currently-playing mock — instead we seed
// tracks + ratings + labels + track_labels directly so there's a library to
// browse. Track URIs are namespaced per worker (the shared, non-cascading
// `tracks` table is the only cross-worker collision risk).

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  await seedTestUser(testUserId(workerIndex), testSpotifyId(workerIndex));
  await seedLibrary(testUserId(workerIndex), workerIndex);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(workerIndex)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
});

test.afterEach(async () => {
  const workerIndex = test.info().workerIndex;
  await teardownTestUser(testUserId(workerIndex));
  await cleanupLibrary(workerIndex);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

const title = (page: import('@playwright/test').Page, text: string) =>
  page.getByText(text, { exact: true });

test('list: renders all seeded tracks and the header count', async ({ page }) => {
  await page.goto('/library');

  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Levitating')).toBeVisible();
  await expect(title(page, 'Time')).toBeVisible();

  // Header count reflects the 4 seeded tracks.
  await expect(page.getByRole('heading', { name: 'Library' })).toContainText('4');
});

test('search by title: narrows to the matching track, clears to restore all', async ({ page }) => {
  await page.goto('/library');
  await expect(title(page, 'Midnight City')).toBeVisible();

  const searchBox = page.getByRole('textbox', { name: 'Search your library' });
  await searchBox.fill('Strobe');

  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Midnight City')).toHaveCount(0);

  await searchBox.fill('');
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Time')).toBeVisible();
});

test('search by label: surfaces tracks carrying the matched label', async ({ page }) => {
  await page.goto('/library');
  await expect(title(page, 'Midnight City')).toBeVisible();

  await page.getByRole('textbox', { name: 'Search your library' }).fill('synth');

  // Only "Midnight City" has the synth label.
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toHaveCount(0);
  await expect(title(page, 'Levitating')).toHaveCount(0);
  await expect(title(page, 'Time')).toHaveCount(0);
});

test('filter by rating bucket: ★★★★+ and ★★★★★ chips constrain by minRating', async ({ page }) => {
  await page.goto('/library');
  await expect(title(page, 'Midnight City')).toBeVisible();

  // ★★★★+ → minRating 4: Midnight City (5) + Strobe (4) remain.
  await page.getByRole('button', { name: '★★★★+' }).click();
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Levitating')).toHaveCount(0);
  await expect(title(page, 'Time')).toHaveCount(0);

  // ★★★★★ → minRating 5: only Midnight City.
  await page.getByRole('button', { name: '★★★★★' }).click();
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toHaveCount(0);

  // Toggle off → all return.
  await page.getByRole('button', { name: '★★★★★' }).click();
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Levitating')).toBeVisible();
  await expect(title(page, 'Time')).toBeVisible();
});

test('filter by label chip: a top label chip constrains then clears', async ({ page }) => {
  await page.goto('/library');
  await expect(title(page, 'Midnight City')).toBeVisible();

  // "night drive" is on 2 tracks → a top label, surfaced as a facet chip.
  const chip = page.getByRole('button', { name: 'night drive' });
  await expect(chip).toBeVisible();

  await chip.click();
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Levitating')).toHaveCount(0);
  await expect(title(page, 'Time')).toHaveCount(0);

  // Click again to clear → all return.
  await chip.click();
  await expect(title(page, 'Levitating')).toBeVisible();
  await expect(title(page, 'Time')).toBeVisible();
});

test('tab bar: Labeled hides unlabeled tracks; Rated keeps all (all seeded tracks have ratings)', async ({ page }) => {
  await page.goto('/library');
  await expect(title(page, 'Midnight City')).toBeVisible();

  // "Time" has a rating but no labels — should drop under the Labeled tab.
  await page.getByTestId('library-tab-labeled').click();
  await expect(title(page, 'Midnight City')).toBeVisible();
  await expect(title(page, 'Strobe')).toBeVisible();
  await expect(title(page, 'Levitating')).toBeVisible();
  await expect(title(page, 'Time')).toHaveCount(0);

  // Rated → all four come back.
  await page.getByTestId('library-tab-rated').click();
  await expect(title(page, 'Time')).toBeVisible();

  // All → still four.
  await page.getByTestId('library-tab-all').click();
  await expect(title(page, 'Time')).toBeVisible();
});

test('bottom nav: visible on library, routes to now-playing', async ({ page }) => {
  await page.goto('/library');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav).toBeVisible();
  await nav.getByRole('link', { name: 'Now Playing' }).click();
  await expect(page).toHaveURL('/now-playing');
  // Still present on the destination screen.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

test('api: /api/library?minRating=4 returns the high-rated rows', async ({ page }) => {
  const res = await page.request.get('/api/library?minRating=4');
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { rows: { title: string }[] };
  const titles = data.rows.map((r) => r.title).sort();
  expect(titles).toEqual(['Midnight City', 'Strobe']);
});

test('sort: rating sort orders songs high → low', async ({ page }) => {
  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('library-sort-button').click();
  await expect(page.getByTestId('library-sort-rating')).toBeVisible();
  await page.getByTestId('library-sort-rating').click();
  await page.waitForLoadState('networkidle');
  const titles = await page.getByTestId('library-row').allInnerTexts();
  // Seed ratings: Midnight City 5, Strobe 4, Levitating 3, Time 2
  expect(titles[0]).toContain('Midnight City');
  expect(titles[1]).toContain('Strobe');
  expect(titles[2]).toContain('Levitating');
  expect(titles[3]).toContain('Time');
});

test('artists view: lists each seeded artist with their song count', async ({ page }) => {
  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('library-view-artists').click({ force: true });
  await expect(page.getByTestId('artist-row')).toHaveCount(4);
});

test('artists drill-in: clicking an artist navigates to that artist\'s songs', async ({ page }) => {
  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('library-view-artists').click({ force: true });
  await page.getByTestId('artist-row').filter({ hasText: 'M83' }).click({ force: true });
  await expect(page).toHaveURL(/\/library\/artist\/M83/);
  await expect(page.getByText('Midnight City', { exact: true })).toBeVisible();
});

test('api: /api/library/artists returns Bayesian scores for each artist', async ({ page }) => {
  const res = await page.request.get('/api/library/artists');
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { rows: { name: string; count: number; score: number }[] };
  expect(data.rows).toHaveLength(4);
  for (const row of data.rows) {
    expect(row.count).toBe(1);
    expect(row.score).toBeGreaterThan(0);
    expect(row.score).toBeLessThanOrEqual(5);
  }
});
