import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  closeSeedConnection,
  getRating,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';
import {
  mockCurrentlyPlaying,
  trackFixture,
  emptyFixture,
  FIXTURE_TRACK_URI,
  type CurrentlyPlayingFixture,
} from './mocks/spotify';

// Rating flow against a mocked Spotify. OAuth is bypassed by injecting a signed
// session cookie for a seeded test user; the Spotify-dependent read
// (/api/spotify/currently-playing) is stubbed at the browser boundary while the
// real /api/ratings endpoint persists to the test DB.

// Disjoint user per Playwright worker so parallel workers never seed/teardown the
// same row. workerIndex is stable for the life of a worker, so the id is the same
// across this worker's beforeEach/afterEach.
const userId = () => testUserId(test.info().workerIndex);

// Map a whole-star value (1-5) to an x-offset that lands within that star's zone.
function offsetForStar(width: number, star: number): number {
  const starW = width / 5;
  return (star - 1) * starW + starW * 0.5;
}

async function tapStar(page: Page, slider: Locator, star: number) {
  const box = await slider.boundingBox();
  if (!box) throw new Error('slider has no bounding box');
  await page.mouse.click(box.x + offsetForStar(box.width, star), box.y + box.height / 2);
}

async function dragToStar(page: Page, slider: Locator, from: number, to: number) {
  const box = await slider.boundingBox();
  if (!box) throw new Error('slider has no bounding box');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + offsetForStar(box.width, from), y);
  await page.mouse.down();
  await page.mouse.move(box.x + offsetForStar(box.width, to), y, { steps: 10 });
  await page.mouse.up();
}

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  await seedTestUser(testUserId(workerIndex), testSpotifyId(workerIndex));
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(workerIndex)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
});

test.afterEach(async () => {
  await teardownTestUser(testUserId(test.info().workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('rate: tapping the 4th star persists rating 4', async ({ page }) => {
  let fixture: CurrentlyPlayingFixture = trackFixture(null);
  await mockCurrentlyPlaying(page, () => fixture);

  await page.goto('/now-playing');
  await expect(page.getByRole('heading', { name: 'Test Track Title' })).toBeVisible();

  const slider = page.getByRole('slider', { name: 'Rating' });
  await expect(slider).toHaveAttribute('aria-valuenow', '0');

  // Tap the 4th star → 4 stars.
  const ratePut = page.waitForRequest(
    (req) => req.url().endsWith('/api/ratings') && req.method() === 'PUT',
  );
  await tapStar(page, slider, 4);

  const req = await ratePut;
  expect(req.postDataJSON()).toMatchObject({
    spotifyTrackUri: FIXTURE_TRACK_URI,
    ratingStars: 4,
  });
  const resp = await req.response();
  expect(resp?.status()).toBe(200);

  // Optimistic UI reflects 4 immediately.
  await expect(slider).toHaveAttribute('aria-valuenow', '4');

  // True persistence: the row really landed in the DB.
  await expect.poll(() => getRating(userId(), FIXTURE_TRACK_URI)).toBe(4);

  // Reload with the persisted rating served by the mock → UI rehydrates to 4.
  fixture = trackFixture(4);
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Rating' })).toHaveAttribute(
    'aria-valuenow',
    '4',
  );
});

test('drag: pressing and dragging across the stars persists the released value', async ({
  page,
}) => {
  let fixture: CurrentlyPlayingFixture = trackFixture(null);
  await mockCurrentlyPlaying(page, () => fixture);

  await page.goto('/now-playing');
  await expect(page.getByRole('heading', { name: 'Test Track Title' })).toBeVisible();

  const slider = page.getByRole('slider', { name: 'Rating' });
  await expect(slider).toHaveAttribute('aria-valuenow', '0');

  // Press near the 1st star and drag to the 4th → 4.
  const ratePut = page.waitForRequest(
    (req) => req.url().endsWith('/api/ratings') && req.method() === 'PUT',
  );
  await dragToStar(page, slider, 1, 4);

  const req = await ratePut;
  expect(req.postDataJSON()).toMatchObject({
    spotifyTrackUri: FIXTURE_TRACK_URI,
    ratingStars: 4,
  });
  expect((await req.response())?.status()).toBe(200);

  await expect(slider).toHaveAttribute('aria-valuenow', '4');
  await expect.poll(() => getRating(userId(), FIXTURE_TRACK_URI)).toBe(4);
});

test('clear: tapping the same zone again removes the rating', async ({ page }) => {
  let fixture: CurrentlyPlayingFixture = trackFixture(4);
  await mockCurrentlyPlaying(page, () => fixture);

  await page.goto('/now-playing');
  const slider = page.getByRole('slider', { name: 'Rating' });
  await expect(slider).toHaveAttribute('aria-valuenow', '4');

  // Tapping the already-set value (4) without dragging clears → DELETE.
  const rateDelete = page.waitForRequest(
    (req) => req.url().endsWith('/api/ratings') && req.method() === 'DELETE',
  );
  await tapStar(page, slider, 4);

  const req = await rateDelete;
  expect(req.postDataJSON()).toMatchObject({ spotifyTrackUri: FIXTURE_TRACK_URI });
  const resp = await req.response();
  expect(resp?.status()).toBe(200);

  await expect(slider).toHaveAttribute('aria-valuenow', '0');

  // DB row is gone.
  await expect.poll(() => getRating(userId(), FIXTURE_TRACK_URI)).toBeNull();

  // Reload with no rating → UI stays at 0.
  fixture = trackFixture(null);
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Rating' })).toHaveAttribute(
    'aria-valuenow',
    '0',
  );
});

test('empty: nothing playing renders the empty state', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => emptyFixture);

  await page.goto('/now-playing');
  await expect(
    page.getByText('Nothing playing in Spotify right now'),
  ).toBeVisible();
});
