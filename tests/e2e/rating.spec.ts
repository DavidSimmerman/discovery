import { test, expect } from '@playwright/test';
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

test('rate: tapping the 4th star full zone persists rating 8', async ({ page }) => {
  let fixture: CurrentlyPlayingFixture = trackFixture(null);
  await mockCurrentlyPlaying(page, () => fixture);

  await page.goto('/now-playing');
  await expect(page.getByRole('heading', { name: 'Test Track Title' })).toBeVisible();

  const slider = page.getByRole('slider', { name: 'Rating' });
  await expect(slider).toHaveAttribute('aria-valuenow', '0');

  // 4th star, full (right) zone → 8 half-steps.
  const ratePut = page.waitForRequest(
    (req) => req.url().endsWith('/api/ratings') && req.method() === 'PUT',
  );
  await page.getByRole('button', { name: '8 half-steps' }).click();

  const req = await ratePut;
  expect(req.postDataJSON()).toMatchObject({
    spotifyTrackUri: FIXTURE_TRACK_URI,
    ratingHalfSteps: 8,
  });
  const resp = await req.response();
  expect(resp?.status()).toBe(200);

  // Optimistic UI reflects 8 immediately.
  await expect(slider).toHaveAttribute('aria-valuenow', '8');

  // True persistence: the row really landed in the DB.
  await expect.poll(() => getRating(userId(), FIXTURE_TRACK_URI)).toBe(8);

  // Reload with the persisted rating served by the mock → UI rehydrates to 8.
  fixture = trackFixture(8);
  await page.reload();
  await expect(page.getByRole('slider', { name: 'Rating' })).toHaveAttribute(
    'aria-valuenow',
    '8',
  );
});

test('clear: tapping the same zone again removes the rating', async ({ page }) => {
  let fixture: CurrentlyPlayingFixture = trackFixture(8);
  await mockCurrentlyPlaying(page, () => fixture);

  await page.goto('/now-playing');
  const slider = page.getByRole('slider', { name: 'Rating' });
  await expect(slider).toHaveAttribute('aria-valuenow', '8');

  // Tapping the already-set zone (8) clears → DELETE.
  const rateDelete = page.waitForRequest(
    (req) => req.url().endsWith('/api/ratings') && req.method() === 'DELETE',
  );
  await page.getByRole('button', { name: '8 half-steps' }).click();

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
