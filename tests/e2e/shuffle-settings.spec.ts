import { test, expect, type Page } from '@playwright/test';
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

// Shuffle settings (Sources tab): pick sources, see live counts, persist.
// Spotify playlist endpoints are mocked at the browser level — the page only
// talks to them via fetch. The seeded user has no Spotify token, so the
// settings/load + save path is exercised against the real DB.

const PLAYLIST = { id: 'e2e-playlist-1', name: 'Apple Music Imports', imageUrl: null, total: 4 };
const STATS = { total: 4, rated: 1, unrated: 3 };

async function mockPlaylistApis(page: Page) {
  await page.route('**/api/shuffle/playlists', (route) =>
    route.fulfill({ json: { playlists: [PLAYLIST] } }),
  );
  await page.route(`**/api/shuffle/playlists/${PLAYLIST.id}/stats`, (route) =>
    route.fulfill({ json: STATS }),
  );
}

test.beforeEach(async ({ context, page }) => {
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
  await mockPlaylistApis(page);
});

test.afterEach(async () => {
  const workerIndex = test.info().workerIndex;
  await cleanupLibrary(workerIndex);
  await teardownTestUser(testUserId(workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

test('library source is on by default with a live count', async ({ page }) => {
  await page.goto('/shuffle-settings');
  const library = page.getByTestId('source-library');
  await expect(library).toContainText('Discovery library');
  await expect(library).toContainText('rated · 4');
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 4 songs');
});

test('adding a playlist in unrated mode updates the count and persists', async ({ page }) => {
  await page.goto('/shuffle-settings');

  // Open the picker and select the mocked playlist.
  await page.getByTestId('add-playlist').click();
  const option = page.getByTestId('playlist-picker-option');
  await expect(option).toContainText('Apple Music Imports');
  await expect(option).toContainText('3 unrated · 4 total');
  await option.click();
  await page.getByRole('button', { name: 'Done' }).click();

  // Card appears, defaulting to "Unrated only", and the CTA adds its 3 unrated.
  const card = page.getByTestId('source-playlist');
  await expect(card).toContainText('Apple Music Imports');
  await expect(card).toContainText('3 unrated of 4');
  await expect(card.getByRole('button', { name: 'Unrated only' })).toHaveClass(/from-purple/);
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 7 songs');

  // Library off → playlist only.
  await page.getByTestId('source-library').click();
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 3 songs');

  // Mode → Rated flips the playlist contribution to its rated count.
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/shuffle/settings') && r.request().method() === 'PUT' && r.ok(),
  );
  await card.getByRole('button', { name: 'Rated', exact: true }).click();
  await expect(page.getByTestId('shuffle-cta')).toContainText('Shuffle 1 song');

  // Edits auto-save (debounced); reload shows the same sources from the DB.
  await saved;
  await page.goto('/shuffle-settings');
  await expect(page.getByTestId('source-playlist')).toContainText('Apple Music Imports');
  const libraryCheck = page.getByTestId('source-library');
  await expect(libraryCheck).not.toHaveClass(/border-purple/);
});

test('deselecting every source disables the shuffle button', async ({ page }) => {
  await page.goto('/shuffle-settings');
  await page.getByTestId('source-library').click();
  await expect(page.getByTestId('shuffle-cta')).toBeDisabled();
});
