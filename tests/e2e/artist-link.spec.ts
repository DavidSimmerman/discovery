import { test, expect } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  seedLibrary,
  cleanupLibrary,
  libraryTrackUris,
  seedMultiArtistTrack,
  cleanupMultiArtistTrack,
  MULTI_ARTIST_NAMES,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';

// Artist-link e2e: clicking the artist name under a song title navigates to that
// artist in the library. Single artist → direct nav; multiple artists → a picker
// sheet. Exercised on the track-detail page (same component, ArtistLink, also
// powers now-playing). Auth bypassed via the seeded-user signed cookie, same as
// the rating/labels/library specs.

let multiArtistTrackUri = '';

test.beforeEach(async ({ context }) => {
  const workerIndex = test.info().workerIndex;
  await seedTestUser(testUserId(workerIndex), testSpotifyId(workerIndex));
  await seedLibrary(testUserId(workerIndex), workerIndex);
  multiArtistTrackUri = await seedMultiArtistTrack(testUserId(workerIndex), workerIndex);
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
  await cleanupMultiArtistTrack(workerIndex);
  await cleanupLibrary(workerIndex);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('single artist: clicking the name navigates straight to that artist', async ({ page }) => {
  const workerIndex = test.info().workerIndex;
  // "Midnight City" by M83 — single artist (slot 0 of the library fixture).
  const midnightCityUri = libraryTrackUris(workerIndex)[0];
  await page.goto(`/library/track/${encodeURIComponent(midnightCityUri)}`);
  await page.waitForLoadState('networkidle');

  const link = page.getByTestId('artist-link');
  await expect(link).toHaveText('M83');
  await link.click();

  await expect(page).toHaveURL(/\/library\/artist\/M83/);
  // No picker sheet for a single artist.
  await expect(page.getByTestId('artist-picker-sheet')).toHaveCount(0);
});

test('multiple artists: clicking opens a picker sheet, and a choice navigates', async ({ page }) => {
  await page.goto(`/library/track/${encodeURIComponent(multiArtistTrackUri)}`);
  await page.waitForLoadState('networkidle');

  const link = page.getByTestId('artist-link');
  await expect(link).toHaveText(MULTI_ARTIST_NAMES.join(', '));

  // Sheet is not shown until clicked.
  await expect(page.getByTestId('artist-picker-sheet')).toHaveCount(0);
  await link.click();

  const sheet = page.getByTestId('artist-picker-sheet');
  await expect(sheet).toBeVisible();

  const options = page.getByTestId('artist-picker-option');
  await expect(options).toHaveCount(MULTI_ARTIST_NAMES.length);

  // Pick the second artist → navigate to it.
  await options.filter({ hasText: 'Rihanna' }).click();
  await expect(page).toHaveURL(/\/library\/artist\/Rihanna/);
});
