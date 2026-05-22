import { test, expect } from '@playwright/test';
import {
  seedTestUser,
  teardownTestUser,
  closeSeedConnection,
  getTrackLabels,
  getLabelByName,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';
import { mockCurrentlyPlaying, trackFixture, FIXTURE_TRACK_URI } from './mocks/spotify';

// Label flow against a mocked Spotify. Same harness as rating.spec.ts: OAuth is
// bypassed via an injected signed session cookie for a per-worker seeded user,
// the Spotify currently-playing read is stubbed at the browser boundary, and the
// real /api/labels + /api/track-labels endpoints persist to the test DB.

const userId = () => testUserId(test.info().workerIndex);

test.beforeEach(async ({ context, page }) => {
  const workerIndex = test.info().workerIndex;
  await seedTestUser(testUserId(workerIndex), testSpotifyId(workerIndex));
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: signSessionCookieValue(testUserId(workerIndex)),
      url: 'http://127.0.0.1:5173',
    },
  ]);
  // A track is playing (rating irrelevant — the label UI shows whenever playing).
  await mockCurrentlyPlaying(page, () => trackFixture(null));
});

test.afterEach(async () => {
  await teardownTestUser(testUserId(test.info().workerIndex));
});

test.afterAll(async () => {
  await closeSeedConnection();
});

async function gotoNowPlaying(page: import('@playwright/test').Page) {
  await page.goto('/now-playing');
  await expect(page.getByRole('heading', { name: 'Test Track Title' })).toBeVisible();
}

test('create + apply: a new label persists the label row and the association', async ({ page }) => {
  await gotoNowPlaying(page);

  await page.getByRole('button', { name: '+ add' }).click();
  const input = page.getByRole('textbox', { name: 'Add a label' });
  await input.fill('night drive');

  const post = page.waitForRequest(
    (req) => req.url().endsWith('/api/track-labels') && req.method() === 'POST',
  );
  await input.press('Enter');

  const req = await post;
  expect(req.postDataJSON()).toMatchObject({
    spotifyTrackUri: FIXTURE_TRACK_URI,
    name: 'night drive',
  });
  expect((await req.response())?.status()).toBe(200);

  // Applied chip appears.
  await expect(page.getByRole('button', { name: 'Remove label night drive' })).toBeVisible();

  // DB: label row exists and the association landed.
  await expect.poll(() => getTrackLabels(userId(), FIXTURE_TRACK_URI)).toContain('night drive');
  expect(await getLabelByName(userId(), 'night drive')).not.toBeNull();
});

test('remove: drops the association but keeps the label row', async ({ page }) => {
  await gotoNowPlaying(page);

  // Create + apply first.
  await page.getByRole('button', { name: '+ add' }).click();
  const input = page.getByRole('textbox', { name: 'Add a label' });
  await input.fill('chill');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove label chill' })).toBeVisible();
  await expect.poll(() => getTrackLabels(userId(), FIXTURE_TRACK_URI)).toContain('chill');

  // Remove the association.
  const del = page.waitForRequest(
    (req) => req.url().endsWith('/api/track-labels') && req.method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Remove label chill' }).click();

  const req = await del;
  expect(req.postDataJSON()).toMatchObject({ spotifyTrackUri: FIXTURE_TRACK_URI });
  expect((await req.response())?.status()).toBe(200);

  // Applied chip is gone (it becomes a suggestion).
  await expect(page.getByRole('button', { name: 'Remove label chill' })).toHaveCount(0);

  // DB: association removed, label row still present.
  await expect.poll(() => getTrackLabels(userId(), FIXTURE_TRACK_URI)).not.toContain('chill');
  expect(await getLabelByName(userId(), 'chill')).not.toBeNull();
});

test('MRU: re-applying a label bumps its lastUsedAt above a newer label', async ({ page }) => {
  await gotoNowPlaying(page);

  const input = page.getByRole('textbox', { name: 'Add a label' });

  // Create "alpha".
  await page.getByRole('button', { name: '+ add' }).click();
  await input.fill('alpha');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove label alpha' })).toBeVisible();

  // Create "beta" (now the most-recently-used).
  await page.getByRole('button', { name: '+ add' }).click();
  await input.fill('beta');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove label beta' })).toBeVisible();
  await expect.poll(() => getTrackLabels(userId(), FIXTURE_TRACK_URI)).toEqual(['alpha', 'beta']);

  // Re-use "alpha": remove then re-apply it via a fresh POST → bumps lastUsedAt.
  await page.getByRole('button', { name: 'Remove label alpha' }).click();
  await expect(page.getByRole('button', { name: 'Add label alpha' })).toBeVisible();

  const repost = page.waitForRequest(
    (req) => req.url().endsWith('/api/track-labels') && req.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Add label alpha' }).click();
  await (await repost).response();
  await expect(page.getByRole('button', { name: 'Remove label alpha' })).toBeVisible();

  // DB: alpha's lastUsedAt is now newer than beta's.
  await expect
    .poll(async () => {
      const alpha = await getLabelByName(userId(), 'alpha');
      const beta = await getLabelByName(userId(), 'beta');
      if (!alpha || !beta) return false;
      return alpha.lastUsedAt.getTime() >= beta.lastUsedAt.getTime();
    })
    .toBe(true);

  // And the GET /api/labels MRU ordering surfaces alpha before beta.
  const res = await page.request.get('/api/labels');
  const { labels } = (await res.json()) as { labels: { name: string }[] };
  const names = labels.map((l) => l.name);
  expect(names.indexOf('alpha')).toBeLessThan(names.indexOf('beta'));
});

test('fuzzy match: typing a substring surfaces an existing label as an option', async ({
  page,
}) => {
  await gotoNowPlaying(page);

  // Create "night drive" first.
  await page.getByRole('button', { name: '+ add' }).click();
  let input = page.getByRole('textbox', { name: 'Add a label' });
  await input.fill('night drive');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove label night drive' })).toBeVisible();

  // Reopen the add panel and type a substring.
  await page.getByRole('button', { name: '+ add' }).click();
  input = page.getByRole('textbox', { name: 'Add a label' });
  await input.fill('night');

  // The existing "night drive" is offered as a selectable option (a button
  // labelled with its name), not just a Create option.
  await expect(
    page.getByRole('button', { name: 'night drive', exact: true }),
  ).toBeVisible();
});
