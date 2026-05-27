import { test, expect } from '@playwright/test';
import postgres from 'postgres';
import {
  seedTestUser,
  teardownTestUser,
  closeSeedConnection,
  signSessionCookieValue,
  SESSION_COOKIE_NAME,
  testUserId,
  testSpotifyId,
} from './fixtures/seed';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set for ISRC dedupe e2e');

// Direct server-side test of the ISRC dedup fix. Two distinct Spotify URIs
// represent the same recording (same ISRC). Rating either one — in either order
// — must leave exactly one row in `ratings`, with the latest rating value, so
// the user never sees the same song reviewed twice.

const URI_A = 'spotify:track:DupeA00000000000000001';
const URI_B = 'spotify:track:DupeB00000000000000002';
const SHARED_ISRC = 'DEDUP1234567';

const sql = postgres(DATABASE_URL!, { max: 1 });

async function seedDuplicateTracks() {
  // tracks table is shared across workers but URIs here are test-only; idempotent upsert.
  await sql`
    INSERT INTO tracks (spotify_track_uri, isrc, title, artists, album, duration_ms)
    VALUES
      (${URI_A}, ${SHARED_ISRC}, 'Dupe Recording', ${['Test Artist'] as unknown as string}, 'Album A', 200000),
      (${URI_B}, ${SHARED_ISRC}, 'Dupe Recording', ${['Test Artist'] as unknown as string}, 'Album B', 200000)
    ON CONFLICT (spotify_track_uri) DO UPDATE SET isrc = EXCLUDED.isrc
  `;
}

async function cleanupTracks() {
  await sql`DELETE FROM tracks WHERE spotify_track_uri IN (${URI_A}, ${URI_B})`;
}

async function countRatings(userId: string): Promise<number> {
  const rows = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM ratings WHERE user_id = ${userId}
  `;
  return rows[0]?.c ?? 0;
}

async function listRatings(userId: string) {
  return sql<{ spotify_track_uri: string; rating_stars: number; isrc: string | null }[]>`
    SELECT spotify_track_uri, rating_stars, isrc FROM ratings WHERE user_id = ${userId}
  `;
}

test.beforeAll(async () => {
  await seedDuplicateTracks();
});

test.afterAll(async () => {
  await cleanupTracks();
  await sql.end({ timeout: 5 });
  await closeSeedConnection();
});

test.beforeEach(async ({ context }) => {
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
});

test.afterEach(async () => {
  await teardownTestUser(testUserId(test.info().workerIndex));
});

test('rating two URIs with the same ISRC leaves exactly one row, with the latest value', async ({ page }) => {
  const userId = testUserId(test.info().workerIndex);

  // First rating under URI_A.
  let res = await page.request.put('/api/ratings', {
    data: { spotifyTrackUri: URI_A, ratingStars: 3, isrc: SHARED_ISRC },
  });
  expect(res.status()).toBe(200);
  expect(await countRatings(userId)).toBe(1);

  // Now Spotify hands us the same recording under a different URI (Smart
  // Shuffle / relinking). The server must update the existing row instead of
  // inserting a second one.
  res = await page.request.put('/api/ratings', {
    data: { spotifyTrackUri: URI_B, ratingStars: 4, isrc: SHARED_ISRC },
  });
  expect(res.status()).toBe(200);

  const rows = await listRatings(userId);
  expect(rows).toHaveLength(1);
  expect(rows[0].rating_stars).toBe(4);
  // The canonical row should still be URI_A (first to be rated).
  expect(rows[0].spotify_track_uri).toBe(URI_A);
});

test('GET /api/ratings resolves via ISRC when looking up a duplicate URI', async ({ page }) => {
  // Rate URI_A, then look up URI_B by URI alone — server must return the rating
  // via ISRC fallback.
  let res = await page.request.put('/api/ratings', {
    data: { spotifyTrackUri: URI_A, ratingStars: 4, isrc: SHARED_ISRC },
  });
  expect(res.status()).toBe(200);

  res = await page.request.get(`/api/ratings?uri=${encodeURIComponent(URI_B)}`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ ratingStars: 4 });
});
