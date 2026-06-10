import { test, expect, type Page } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
  getRating,
} from './fixtures/seed';

// Unrated Liked Songs: now-playing alert card, Library callout, /liked review
// list. The /api/liked/unrated endpoint reaches Spotify server-side, so it's
// mocked at the browser level; rating PUTs hit the real DB.

function likedTrackUri(workerIndex: number, i: number): string {
  return `spotify:track:e2eliked${String(workerIndex).padStart(2, '0')}${String(i).padStart(12, '0')}`;
}

function mockLikedApi(page: Page, workerIndex: number, unratedCount = 2, total = 5) {
  const tracks = Array.from({ length: unratedCount }, (_, i) => ({
    uri: likedTrackUri(workerIndex, i),
    name: `Liked Jam ${i + 1}`,
    artists: ['E2E Artist'],
    albumArtUrl: null,
    durationMs: 201_000,
    isrc: null,
  }));
  return page.route('**/api/liked/unrated**', (route) => {
    const url = new URL(route.request().url());
    const base = { total, rated: total - unratedCount, unrated: unratedCount };
    if (url.searchParams.get('count') === '1') return route.fulfill({ json: base });
    return route.fulfill({ json: { ...base, tracks } });
  });
}

test.beforeEach(async ({ context, page }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await seedTestUser(userId, testSpotifyId(workerIndex));
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(userId),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  await mockLikedApi(page, workerIndex);
});

test.afterEach(async () => {
  await teardownTestUser(testUserId(test.info().workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('now-playing shows the alert card; dismiss hides it', async ({ page }) => {
  await page.goto('/now-playing');
  const card = page.getByTestId('liked-alert');
  await expect(card).toContainText('2 liked songs aren’t rated yet');
  await card.getByLabel('Dismiss').click();
  await expect(card).toHaveCount(0);
});

test('alert Review button opens /liked', async ({ page }) => {
  await page.goto('/now-playing');
  await page.getByTestId('liked-alert').getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/liked$/);
  await expect(page.getByTestId('liked-row')).toHaveCount(2);
});

test('library shows the callout linking to /liked', async ({ page }) => {
  await page.goto('/library');
  const callout = page.getByTestId('liked-callout');
  await expect(callout).toContainText('2 unrated of 5');
  await callout.click();
  await expect(page).toHaveURL(/\/liked$/);
});

test('rating a row persists, updates counts, and keeps the row visible', async ({ page }) => {
  const workerIndex = test.info().workerIndex;
  const userId = testUserId(workerIndex);
  await page.goto('/liked');

  await expect(page.getByText('2 of 5 liked songs have no rating')).toBeVisible();

  const row = page.getByTestId('liked-row').filter({ hasText: 'Liked Jam 1' });
  // Click the centre of the star slider → 3 stars.
  await row.getByRole('slider', { name: 'Rating' }).click();

  await expect.poll(() => getRating(userId, likedTrackUri(workerIndex, 0))).toBe(3);
  // Row stays (mis-taps correctable), header + CTA reflect the remaining count.
  await expect(row).toBeVisible();
  await expect(page.getByText('1 of 5 liked songs has no rating')).toBeVisible();
  await expect(page.getByTestId('liked-shuffle-cta')).toContainText('Shuffle these 1');
});

test('shuffle CTA saves liked/unrated as the only shuffle source', async ({ page }) => {
  await page.goto('/liked');
  const putSettings = page.waitForRequest(
    (r) => r.url().includes('/api/shuffle/settings') && r.method() === 'PUT',
  );
  await page.getByTestId('liked-shuffle-cta').click();
  const req = await putSettings;
  const body = req.postDataJSON() as {
    settings: { sources: { library: boolean; discovery: boolean; playlists: { id: string; mode: string }[] } };
  };
  expect(body.settings.sources.library).toBe(false);
  expect(body.settings.sources.discovery).toBe(false);
  expect(body.settings.sources.playlists).toEqual([
    { id: '__liked__', name: 'Liked Songs', mode: 'unrated' },
  ]);
});
