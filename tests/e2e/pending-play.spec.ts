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
import { mockSpotifySdk } from './mocks/spotify-sdk';
import { mockCurrentlyPlaying, type CurrentlyPlayingFixture } from './mocks/spotify';

// Cold-start pending play: shuffle with no Spotify device anywhere arms a
// server-side job (the queue fires when Spotify opens) and the Now Playing
// page shows the pending card instead of the empty state. These specs mock
// the /api/spotify/* boundary; the shuffle timeline endpoint runs for real
// against the seeded library (same approach as playback-shuffle.spec).

test.beforeEach(async ({ context, page }) => {
  const w = test.info().workerIndex;
  await seedTestUser(testUserId(w), testSpotifyId(w), 'premium');
  await seedLibrary(testUserId(w), w);
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(w)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  await mockSpotifySdk(page);
});

test.afterEach(async () => {
  const w = test.info().workerIndex;
  await teardownTestUser(testUserId(w));
  await cleanupLibrary(w);
});

test.afterAll(async () => {
  await closeSeedConnection();
});

// Play always 409s (no device anywhere) — the trigger for the pending path.
async function stubNoDevicePlay(page: Page): Promise<void> {
  await page.route('**/api/spotify/player/play', (r) =>
    r.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'no_active_device' }),
    }),
  );
}

// Stub the pending-play job endpoint. `state.status` is read lazily on each
// GET so a test can flip it (pending → started/expired) mid-flight; POSTed
// queues and DELETE calls are captured for assertions.
type PendingStub = { status: string; posted: string[][]; deletes: number };

async function stubPendingRoutes(page: Page): Promise<PendingStub> {
  const stub: PendingStub = { status: 'pending', posted: [], deletes: 0 };
  await page.route('**/api/spotify/player/pending', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { uris?: string[] };
      stub.posted.push(body.uris ?? []);
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending' }),
      });
    } else if (method === 'DELETE') {
      stub.deletes += 1;
      await route.fulfill({ status: 204 });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({ status: stub.status }),
      });
    }
  });
  return stub;
}

// The pending status poll only runs while pendingPlay is set; visibilitychange
// triggers an immediate check — fire it after flipping the stub so the test
// doesn't sit out the 2s poll interval.
async function kickPendingCheck(page: Page): Promise<void> {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

async function armViaShuffle(page: Page): Promise<void> {
  await page.goto('/now-playing');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByTestId('pending-play-card')).toBeVisible({ timeout: 10_000 });
}

test('shuffle with no device arms a pending play and shows the card', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubNoDevicePlay(page);
  const pending = await stubPendingRoutes(page);

  await armViaShuffle(page);

  // The sampler queue was handed to the server job.
  expect(pending.posted).toHaveLength(1);
  expect(pending.posted[0].length).toBeGreaterThan(0);

  // Card contents: CTA + autostart caption.
  const card = page.getByTestId('pending-play-card');
  await expect(card).toContainText('Shuffle queued and ready');
  await expect(page.getByTestId('open-spotify-button')).toBeVisible();
  await expect(card).toContainText('starts automatically when Spotify opens');

  // Shuffle pills are hidden while the pending card is up.
  await expect(page.getByTestId('shuffle-button')).toHaveCount(0);
  await expect(page.getByTestId('shuffle-settings-link')).toHaveCount(0);
});

test('pending → started adopts the sampler session', async ({ page }) => {
  let playing: CurrentlyPlayingFixture = { playing: null, rating: null };
  await mockCurrentlyPlaying(page, () => playing);
  await stubNoDevicePlay(page);
  const pending = await stubPendingRoutes(page);

  await armViaShuffle(page);

  // Server fires the play: status flips to started and Spotify reports the
  // queue's first track as currently playing.
  const firstUri = pending.posted[0][0];
  playing = {
    playing: {
      uri: firstUri,
      name: 'Adopted Track',
      artists: ['Adopted Artist'],
      album: 'Adopted Album',
      albumArtUrl: null,
      durationMs: 200_000,
      progressMs: 1_000,
      isPlaying: true,
      isrc: null,
    },
    rating: null,
  };
  pending.status = 'started';
  await kickPendingCheck(page);

  // Card gone, the track renders, and the store adopted the session — the
  // transport (next/prev) is live for the playing track.
  await expect(page.getByTestId('pending-play-card')).toHaveCount(0);
  await expect(page.getByText('Adopted Track')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next track' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous track' })).toBeVisible();
});

test('cancel clears the card and restores the empty state', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubNoDevicePlay(page);
  const pending = await stubPendingRoutes(page);

  await armViaShuffle(page);
  await page.getByTestId('pending-cancel').click();

  await expect(page.getByTestId('pending-play-card')).toHaveCount(0);
  await expect.poll(() => pending.deletes).toBeGreaterThan(0);
  // Empty state + shuffle pills are back.
  await expect(page.getByText('Nothing playing in Spotify right now')).toBeVisible();
  await expect(page.getByTestId('shuffle-button')).toBeVisible();
});

test('expired pending play clears the card and keeps the timeline resumable', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubNoDevicePlay(page);
  const pending = await stubPendingRoutes(page);

  await armViaShuffle(page);
  pending.status = 'expired';
  await kickPendingCheck(page);

  // No playback started, card gone…
  await expect(page.getByTestId('pending-play-card')).toHaveCount(0);
  await expect(page.getByText('Nothing playing in Spotify right now')).toBeVisible();
  // …and the server timeline survived, so the resume chip is offered.
  await expect(page.getByTestId('resume-shuffle-chip')).toBeVisible({ timeout: 10_000 });
});

test('Open Spotify button opens the web player on desktop', async ({ page }) => {
  // Desktop UA (Playwright's Desktop Chrome) → window.open of open.spotify.com.
  await page.addInitScript(() => {
    (window as unknown as { __openCalls: string[] }).__openCalls = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __openCalls: string[] }).__openCalls.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubNoDevicePlay(page);
  await stubPendingRoutes(page);

  await armViaShuffle(page);
  await page.getByTestId('open-spotify-button').click();

  const calls = await page.evaluate(
    () => (window as unknown as { __openCalls: string[] }).__openCalls,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].startsWith('https://open.spotify.com/')).toBe(true);
});

test('shuffle from /library with no device funnels to the pending card', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubNoDevicePlay(page);
  const pending = await stubPendingRoutes(page);

  await page.goto('/library');
  await page.waitForLoadState('networkidle');
  // Plain (non-sampler) ShuffleButton over the current library filter.
  await page.getByTestId('shuffle-button').first().click();

  // The button navigates to /now-playing so the armed queue has a visible result.
  await page.waitForURL('**/now-playing');
  await expect(page.getByTestId('pending-play-card')).toBeVisible();
  expect(pending.posted).toHaveLength(1);
  expect(pending.posted[0].length).toBeGreaterThan(0);
});
