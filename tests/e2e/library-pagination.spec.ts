import { test, expect } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  seedManyRated,
  cleanupManyRated,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';

// Pagination / lazy-load e2e. Seeds more rated tracks than one page (PAGE_SIZE =
// 50) to prove: the header count is the true total (not the rendered count), the
// list renders only the first page up front, and scrolling lazy-loads the rest.
const SEED_COUNT = 60;
const PAGE_SIZE = 50;

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  await seedTestUser(testUserId(workerIndex), testSpotifyId(workerIndex));
  await seedManyRated(testUserId(workerIndex), workerIndex, SEED_COUNT);
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
  await cleanupManyRated(workerIndex, SEED_COUNT);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('first page is capped at PAGE_SIZE with the true total, and scrolling lazy-loads the rest', async ({
  page,
}) => {
  // Capture the initial listing request (no offset) to prove the server caps the
  // page at PAGE_SIZE while reporting the full, uncapped total.
  const firstResp = page.waitForResponse(
    (r) =>
      /\/api\/library(\?|$)/.test(r.url()) &&
      !r.url().includes('offset') &&
      r.request().method() === 'GET',
  );
  await page.goto('/library');

  const firstBody = await (await firstResp).json();
  expect(firstBody.rows).toHaveLength(PAGE_SIZE); // capped at one page, NOT all 60 (and never 500)
  expect(firstBody.total).toBe(SEED_COUNT); // …but the count is the real total

  // Header shows the true total, not the rendered-row count.
  await expect(page.getByRole('heading', { name: 'Library' })).toContainText(String(SEED_COUNT));

  // Scrolling to the bottom triggers a second page request at offset=PAGE_SIZE,
  // which returns exactly the remainder.
  const moreResp = page.waitForResponse(
    (r) => r.url().includes(`offset=${PAGE_SIZE}`) && r.request().method() === 'GET',
  );
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const moreBody = await (await moreResp).json();
  expect(moreBody.rows).toHaveLength(SEED_COUNT - PAGE_SIZE);

  // Page boundary is clean: the two pages are disjoint and cover the whole set
  // (proves the deterministic sort tie-breaker — no dropped/duplicated rows).
  const firstUris: string[] = firstBody.rows.map((r: { uri: string }) => r.uri);
  const moreUris: string[] = moreBody.rows.map((r: { uri: string }) => r.uri);
  const allUris = new Set([...firstUris, ...moreUris]);
  expect(allUris.size).toBe(SEED_COUNT);

  // All rows are now present and the count is unchanged.
  await expect(page.getByTestId('library-row')).toHaveCount(SEED_COUNT);
  await expect(page.getByRole('heading', { name: 'Library' })).toContainText(String(SEED_COUNT));
});
