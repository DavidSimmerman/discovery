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
import { mockCurrentlyPlaying, trackFixture } from './mocks/spotify';

// Interrupted-shuffle recovery: the server timeline outlives the client, so an
// empty player offers a "Resume shuffle" chip and a foreign track gets a
// dismissible banner. The timeline endpoint is stubbed here (unlike
// pending-play.spec) because these specs need exact control over what the
// server claims is resumable.

const T1 = 'spotify:track:ResumeAaaaaaaaaaaaaaaa';
const T2 = 'spotify:track:ResumeBbbbbbbbbbbbbbbb';
const T3 = 'spotify:track:ResumeCccccccccccccccc';

type TimelineFixture = { history: string[]; current: string | null; upcoming: string[] };

type TimelineStub = {
  timeline: TimelineFixture;
  posts: { action?: string }[];
};

// GET → the fixture (read lazily, so tests can swap it); POST → capture the
// action and echo the fixture back unchanged.
async function stubTimeline(page: Page, initial: TimelineFixture): Promise<TimelineStub> {
  const stub: TimelineStub = { timeline: initial, posts: [] };
  await page.route('**/api/shuffle/timeline', async (route) => {
    if (route.request().method() === 'POST') {
      stub.posts.push(JSON.parse(route.request().postData() ?? '{}'));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ timeline: stub.timeline }),
    });
  });
  return stub;
}

// Banner copy hydrates the next track's title from /api/tracks.
async function stubTracksMeta(page: Page, titleByUri: Record<string, string>): Promise<void> {
  await page.route('**/api/tracks?*', async (route) => {
    const url = new URL(route.request().url());
    const uris = (url.searchParams.get('uris') ?? '').split(',').filter(Boolean);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tracks: uris.map((uri) => ({
          uri,
          title: titleByUri[uri] ?? null,
          artists: titleByUri[uri] ? ['Resume Artist'] : [],
          album: null,
          albumArtUrl: null,
        })),
      }),
    });
  });
}

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

test('empty player offers the resume chip and relabels Shuffle', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });

  await page.goto('/now-playing');

  const chip = page.getByTestId('resume-shuffle-chip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Resume shuffle');
  await expect(chip).toContainText('3 left'); // current + 2 upcoming
  // While the chip is offered, the sampler button reads "New shuffle".
  await expect(page.getByTestId('shuffle-button')).toContainText('New shuffle');
});

test('resume restarts the sampler WITHOUT resetting the timeline', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  const tl = await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });
  let playBody: { uris?: string[] } = {};
  await page.route('**/api/spotify/player/play', async (route) => {
    playBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 204 });
  });

  await page.goto('/now-playing');
  await page.getByTestId('resume-shuffle-chip').click();

  // The push is the parked timeline verbatim: [current, ...upcoming].
  await expect.poll(() => playBody.uris ?? []).toEqual([T1, T2, T3]);
  // Resume must NOT wipe the timeline — no reset action was posted.
  expect(tl.posts.map((p) => p.action)).not.toContain('reset');
  // The store is sampling now, so the offer goes away.
  await expect(page.getByTestId('resume-shuffle-chip')).toHaveCount(0);
});

test('foreign track shows the resume banner with the next-track title', async ({ page }) => {
  // Spotify is playing a track that is NOT in the parked timeline.
  await mockCurrentlyPlaying(page, () => trackFixture());
  await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });
  await stubTracksMeta(page, { [T1]: 'Next Song One' });

  await page.goto('/now-playing');

  const banner = page.getByTestId('resume-shuffle-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Shuffle paused — 3 tracks left');
  await expect(banner).toContainText('Next: Next Song One');
});

test('banner dismissal is session-scoped and keyed to the timeline current', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => trackFixture());
  const tl = await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });
  await stubTracksMeta(page, { [T1]: 'Next Song One', [T2]: 'Next Song Two' });

  await page.goto('/now-playing');
  await expect(page.getByTestId('resume-shuffle-banner')).toBeVisible();
  await page.getByTestId('resume-shuffle-banner-dismiss').click();
  await expect(page.getByTestId('resume-shuffle-banner')).toHaveCount(0);

  // Same session (sessionStorage survives reload) → stays dismissed.
  await page.reload();
  await expect(page.getByTestId('resume-shuffle-chip')).toHaveCount(0);
  await expect(page.getByTestId('resume-shuffle-banner')).toHaveCount(0);

  // A NEW interrupted session (different timeline current) → banner returns.
  tl.timeline = { history: [T1], current: T2, upcoming: [T3] };
  await page.reload();
  await expect(page.getByTestId('resume-shuffle-banner')).toBeVisible();
});

test('no offer while a pending play is armed', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });
  await page.route('**/api/spotify/player/play', (r) =>
    r.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'no_active_device' }),
    }),
  );
  await page.route('**/api/spotify/player/pending', (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending' }),
        })
      : r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'pending' }),
        }),
  );

  await page.goto('/now-playing');
  // Chip is offered first (nothing pending yet)…
  await expect(page.getByTestId('resume-shuffle-chip')).toBeVisible();
  // …then a no-device shuffle arms a pending play, which suppresses the offer.
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByTestId('pending-play-card')).toBeVisible();
  await expect(page.getByTestId('resume-shuffle-chip')).toHaveCount(0);
  await expect(page.getByTestId('resume-shuffle-banner')).toHaveCount(0);
});

test('no offer while sampling', async ({ page }) => {
  await mockCurrentlyPlaying(page, () => ({ playing: null, rating: null }));
  await stubTimeline(page, { history: [], current: T1, upcoming: [T2, T3] });
  await page.route('**/api/spotify/player/play', (r) => r.fulfill({ status: 204 }));

  await page.goto('/now-playing');
  await expect(page.getByTestId('resume-shuffle-chip')).toBeVisible();
  // A successful sampler start (here via the relabeled "New shuffle" button)
  // makes the store sampling — the offer must disappear.
  await page.getByTestId('shuffle-button').click();
  await expect(page.getByTestId('resume-shuffle-chip')).toHaveCount(0);
  await expect(page.getByTestId('resume-shuffle-banner')).toHaveCount(0);
});
