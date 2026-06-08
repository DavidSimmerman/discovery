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
  seedTopTracks,
  seedTopArtists,
  TOP_ONLY_TRACK_NAME,
  topOnlyTrackUri,
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
  // Assert with auto-retrying locators rather than a one-shot allInnerTexts()
  // snapshot: the sort triggers a refetch, and reading the DOM immediately after
  // networkidle races the re-sorted render (the default recency order happens to
  // put Time first, so a too-early read looks like an ascending-sort bug).
  // Seed ratings: Midnight City 5, Strobe 4, Levitating 3, Time 2
  const rows = page.getByTestId('library-row');
  await expect(rows.nth(0)).toContainText('Midnight City');
  await expect(rows.nth(1)).toContainText('Strobe');
  await expect(rows.nth(2)).toContainText('Levitating');
  await expect(rows.nth(3)).toContainText('Time');
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

test('api: /api/library/artists returns a score for each artist', async ({ page }) => {
  const res = await page.request.get('/api/library/artists');
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as {
    rows: { name: string; count: number; avg: number; score: number }[];
  };
  expect(data.rows).toHaveLength(4);
  for (const row of data.rows) {
    expect(row.count).toBe(1);
    expect(typeof row.score).toBe('number');
    expect(row.avg).toBeGreaterThan(0);
    expect(row.avg).toBeLessThanOrEqual(5);
  }
});

// --- "Most listened" (Spotify top tracks/artists) sort ----------------------

test('sort: most listened orders songs by Spotify rank, incl. not-in-library', async ({
  page,
}) => {
  await seedTopTracks(testUserId(test.info().workerIndex), test.info().workerIndex);
  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('library-sort-button').click();
  await expect(page.getByTestId('library-sort-listens')).toBeVisible();
  await page.getByTestId('library-sort-listens').click();

  // Rank order: the not-in-library track (rank 1) first, then the rated ones.
  const rows = page.getByTestId('library-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(TOP_ONLY_TRACK_NAME);
  await expect(rows.nth(1)).toContainText('Midnight City');
  await expect(rows.nth(2)).toContainText('Levitating');

  // The rating/label filter chips are hidden in this view.
  await expect(page.getByRole('button', { name: '★★★★★' })).toHaveCount(0);
});

test('api: /api/library?sort=listens returns top tracks in rank order', async ({ page }) => {
  await seedTopTracks(testUserId(test.info().workerIndex), test.info().workerIndex);
  const res = await page.request.get('/api/library?sort=listens');
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as {
    rows: { title: string | null; rank: number; rating: number | null }[];
  };
  expect(data.rows.map((r) => r.title)).toEqual(['Top Only Anthem', 'Midnight City', 'Levitating']);
  expect(data.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  // The not-in-library rank-1 track has no rating; the others keep their stars.
  expect(data.rows[0].rating).toBeNull();
  expect(data.rows[1].rating).toBe(5);
});

test('sort: most listened lists top artists incl. not-in-library', async ({ page }) => {
  await seedTopArtists(testUserId(test.info().workerIndex));
  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('library-view-artists').click({ force: true });
  await page.getByTestId('artists-sort-button').click();
  await page.getByTestId('artists-sort-listens').click();

  const rows = page.getByTestId('artist-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Pink Floyd');
  await expect(rows.nth(0)).toContainText('Not rated yet');
  await expect(rows.nth(1)).toContainText('M83');
});

test('api: /api/library/artists?sort=listens returns artists in rank order', async ({ page }) => {
  await seedTopArtists(testUserId(test.info().workerIndex));
  const res = await page.request.get('/api/library/artists?sort=listens');
  expect(res.ok()).toBe(true);
  const data = (await res.json()) as { rows: { name: string; count: number }[] };
  expect(data.rows.map((r) => r.name)).toEqual(['Pink Floyd', 'M83', 'deadmau5']);
  expect(data.rows[0].count).toBe(0); // Pink Floyd — not in the library
  expect(data.rows[1].count).toBe(1); // M83 — one rated track
});

test('track page: an unhydrated top track opens (name fallback) instead of 404', async ({
  page,
}) => {
  const workerIndex = test.info().workerIndex;
  await seedTopTracks(testUserId(workerIndex), workerIndex);
  // The rank-1 top track is never cached in `tracks` and has no rating/label —
  // the degraded path where Spotify metadata hydration was skipped. It must
  // still resolve via user_top_tracks so the row's click-through doesn't 404.
  const res = await page.goto(`/library/track/${encodeURIComponent(topOnlyTrackUri(workerIndex))}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText(TOP_ONLY_TRACK_NAME, { exact: true })).toBeVisible();
});
