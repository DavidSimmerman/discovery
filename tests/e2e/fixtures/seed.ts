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

/** Names of labels applied to a track for the user (track_labels → labels join). */
export async function getTrackLabels(userId: string, spotifyTrackUri: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT l.name
    FROM track_labels tl
    JOIN labels l ON l.id = tl.label_id
    WHERE tl.user_id = ${userId} AND tl.spotify_track_uri = ${spotifyTrackUri}
    ORDER BY l.name
  `;
  return rows.map((r) => r.name);
}

/** A label row by name (for existence + MRU comparisons). */
export async function getLabelByName(
  userId: string,
  name: string,
): Promise<{ id: string; lastUsedAt: Date } | null> {
  const rows = await sql<{ id: string; last_used_at: Date }[]>`
    SELECT id, last_used_at FROM labels
    WHERE user_id = ${userId} AND name = ${name}
  `;
  const row = rows[0];
  return row ? { id: row.id, lastUsedAt: row.last_used_at } : null;
}

// --- Library seed -----------------------------------------------------------
// The `tracks` table is NOT user-scoped and does NOT cascade on user delete, so
// parallel workers would collide on a shared track URI and teardown would leak
// rows. We namespace each track URI by workerIndex: a fixed 21-char base + a
// single index digit → a unique, realistic-looking `spotify:track:<22 chars>`.
const TRACK_BASE = ['Midntcity', 'Strobedeadm', 'Levitating', 'TimeHansZmr'];

function trackUri(workerIndex: number, slot: number): string {
  // 22-char id: per-track prefix padded, then the worker index, kept to 22 chars.
  const id = `${TRACK_BASE[slot]}${String(workerIndex).padStart(4, '0')}`.padEnd(22, '0').slice(0, 22);
  return `spotify:track:${id}`;
}

type LibSeedTrack = {
  slot: number;
  title: string;
  artists: string[];
  rating: number;
  labels: string[];
};

const LIBRARY_FIXTURE: LibSeedTrack[] = [
  { slot: 0, title: 'Midnight City', artists: ['M83'], rating: 10, labels: ['night drive', 'synth'] },
  { slot: 1, title: 'Strobe', artists: ['deadmau5'], rating: 9, labels: ['night drive'] },
  { slot: 2, title: 'Levitating', artists: ['Dua Lipa'], rating: 6, labels: ['pop'] },
  { slot: 3, title: 'Time', artists: ['Hans Zimmer'], rating: 4, labels: [] },
];

/** URIs this worker seeds — used for teardown of the non-cascading tracks table. */
export function libraryTrackUris(workerIndex: number): string[] {
  return LIBRARY_FIXTURE.map((t) => trackUri(workerIndex, t.slot));
}

/**
 * Seeds a fixed library for the per-worker user: tracks (shared table, namespaced
 * URIs), ratings + labels + track_labels (user-scoped, cascade on user delete).
 * Designed to exercise search (title/artist/label) and both filters (rating, label).
 */
export async function seedLibrary(userId: string, workerIndex: number): Promise<void> {
  // Dedupe label names per user → name → label id.
  const labelIds = new Map<string, string>();
  const allNames = [...new Set(LIBRARY_FIXTURE.flatMap((t) => t.labels))];
  for (const name of allNames) {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO labels (user_id, name) VALUES (${userId}, ${name})
      RETURNING id
    `;
    labelIds.set(name, rows[0].id);
  }

  for (const t of LIBRARY_FIXTURE) {
    const uri = trackUri(workerIndex, t.slot);
    await sql`
      INSERT INTO tracks (spotify_track_uri, title, artists, album_art_url)
      VALUES (${uri}, ${t.title}, ${t.artists}, ${null})
      ON CONFLICT (spotify_track_uri) DO UPDATE
        SET title = EXCLUDED.title, artists = EXCLUDED.artists
    `;
    await sql`
      INSERT INTO ratings (user_id, spotify_track_uri, rating_half_steps)
      VALUES (${userId}, ${uri}, ${t.rating})
    `;
    for (const name of t.labels) {
      await sql`
        INSERT INTO track_labels (user_id, spotify_track_uri, label_id)
        VALUES (${userId}, ${uri}, ${labelIds.get(name)!})
      `;
    }
  }
}

/** Deletes the worker's seeded tracks rows (tracks does NOT cascade on user delete). */
export async function cleanupLibrary(workerIndex: number): Promise<void> {
  await sql`DELETE FROM tracks WHERE spotify_track_uri = ANY(${libraryTrackUris(workerIndex)})`;
}

export async function closeSeedConnection(): Promise<void> {
  await sql.end({ timeout: 5 });
}
