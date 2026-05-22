import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!DATABASE_URL) throw new Error('DATABASE_URL not set (check .env)');
if (!SESSION_SECRET) throw new Error('SESSION_SECRET not set (check .env)');

// Per-worker test user identity. Playwright runs spec files across parallel
// workers; each worker gets a disjoint user row so concurrent seed/teardown on
// different workers never race on the same `users` row (ratings cascade on
// delete, so a shared row could be wiped mid-test). The id is derived from the
// worker index — a valid uuid v4-shaped string, stable within a worker.
export function testUserId(workerIndex: number): string {
  return `00000000-0000-4000-8000-${String(workerIndex).padStart(12, '0')}`;
}
export function testSpotifyId(workerIndex: number): string {
  return `e2e-test-user-${workerIndex}`;
}
export const TEST_DISPLAY_NAME = 'E2E Test User';

// A connection dedicated to test setup/teardown. Kept separate from the app's
// Drizzle client (which relies on $env/static/private, unavailable in the
// Playwright Node process).
const sql = postgres(DATABASE_URL, { max: 1 });

/** Replicates the app's session signing (see src/lib/server/session.ts). */
export function signSessionCookieValue(userId: string): string {
  const sig = createHmac('sha256', SESSION_SECRET!).update(userId).digest('base64url');
  return `${userId}.${sig}`;
}

export const SESSION_COOKIE_NAME = 'disccovery_session';

/** Idempotent: delete then insert the test user. Ratings cascade on the delete. */
export async function seedTestUser(userId: string, spotifyId: string): Promise<void> {
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql`
    INSERT INTO users (id, spotify_id, display_name)
    VALUES (${userId}, ${spotifyId}, ${TEST_DISPLAY_NAME})
  `;
}

/** Removes the test user; ratings cascade via FK. */
export async function teardownTestUser(userId: string): Promise<void> {
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

export async function getRating(userId: string, spotifyTrackUri: string): Promise<number | null> {
  const rows = await sql<{ rating_half_steps: number }[]>`
    SELECT rating_half_steps FROM ratings
    WHERE user_id = ${userId} AND spotify_track_uri = ${spotifyTrackUri}
  `;
  return rows[0]?.rating_half_steps ?? null;
}

export async function closeSeedConnection(): Promise<void> {
  await sql.end({ timeout: 5 });
}
