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
//
// The connection is created lazily and re-created if it has been closed (e.g.
// when multiple spec files each call closeSeedConnection() in afterAll — the
// module singleton would otherwise be permanently ended for subsequent specs
// that still need it in the same Playwright worker process).
let _sql: ReturnType<typeof postgres> | null = null;

function getDb(): ReturnType<typeof postgres> {
  if (!_sql) {
    _sql = postgres(DATABASE_URL!, { max: 1 });
  }
  return _sql;
}

/** Replicates the app's session signing (see src/lib/server/session.ts). */
export function signSessionCookieValue(userId: string): string {
  const sig = createHmac('sha256', SESSION_SECRET!).update(userId).digest('base64url');
  return `${userId}.${sig}`;
}

export const SESSION_COOKIE_NAME = 'disccovery_session';

/** Idempotent: delete then insert the test user. Ratings cascade on the delete. */
export async function seedTestUser(
  userId: string,
  spotifyId: string,
  product: 'premium' | 'free' | 'open' = 'premium',
): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql`
    INSERT INTO users (id, spotify_id, display_name, product)
    VALUES (${userId}, ${spotifyId}, ${TEST_DISPLAY_NAME}, ${product})
  `;
}

/** Removes the test user; ratings cascade via FK. */
export async function teardownTestUser(userId: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM users WHERE id = ${userId}`;
}

export async function getRating(userId: string, spotifyTrackUri: string): Promise<number | null> {
  const sql = getDb();
  const rows = await sql<{ rating_stars: number }[]>`
    SELECT rating_stars FROM ratings
    WHERE user_id = ${userId} AND spotify_track_uri = ${spotifyTrackUri}
  `;
  return rows[0]?.rating_stars ?? null;
}

/** Names of labels applied to a track for the user (track_labels → labels join). */
export async function getTrackLabels(userId: string, spotifyTrackUri: string): Promise<string[]> {
  const sql = getDb();
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
  const sql = getDb();
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
  { slot: 0, title: 'Midnight City', artists: ['M83'], rating: 5, labels: ['night drive', 'synth'] },
  { slot: 1, title: 'Strobe', artists: ['deadmau5'], rating: 4, labels: ['night drive'] },
  { slot: 2, title: 'Levitating', artists: ['Dua Lipa'], rating: 3, labels: ['pop'] },
  { slot: 3, title: 'Time', artists: ['Hans Zimmer'], rating: 2, labels: [] },
];

/** URIs this worker seeds — used for teardown of the non-cascading tracks table. */
export function libraryTrackUris(workerIndex: number): string[] {
  return LIBRARY_FIXTURE.map((t) => trackUri(workerIndex, t.slot));
}

// --- Bulk seed (pagination / lazy-load) ------------------------------------
// A separate URI namespace ("PG…") from the 4-track LIBRARY_FIXTURE so this and
// the main library spec never collide on the shared, non-cascading tracks table.

function bulkTrackUri(workerIndex: number, i: number): string {
  // 22-char id: "PG" + worker(2) + index(5), zero-padded — unique per (worker, i).
  const id = `PG${String(workerIndex).padStart(2, '0')}${String(i).padStart(5, '0')}`
    .padEnd(22, '0')
    .slice(0, 22);
  return `spotify:track:${id}`;
}

export function bulkTrackUris(workerIndex: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => bulkTrackUri(workerIndex, i));
}

/** Seed `count` rated tracks (rating 3) for the user — for pagination tests. */
export async function seedManyRated(
  userId: string,
  workerIndex: number,
  count: number,
): Promise<void> {
  const sql = getDb();
  for (let i = 0; i < count; i++) {
    const uri = bulkTrackUri(workerIndex, i);
    // Zero-padded ordinal in the title so recency-sort order is deterministic and
    // a specific late row (e.g. "Bulk Track 00059") can be asserted after scroll.
    const title = `Bulk Track ${String(i).padStart(5, '0')}`;
    await sql`
      INSERT INTO tracks (spotify_track_uri, title, artists, album_art_url)
      VALUES (${uri}, ${title}, ${['Bulk Artist']}, ${null})
      ON CONFLICT (spotify_track_uri) DO UPDATE
        SET title = EXCLUDED.title, artists = EXCLUDED.artists
    `;
    await sql`
      INSERT INTO ratings (user_id, spotify_track_uri, rating_stars)
      VALUES (${userId}, ${uri}, ${3})
    `;
  }
}

export async function cleanupManyRated(workerIndex: number, count: number): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM tracks WHERE spotify_track_uri = ANY(${bulkTrackUris(workerIndex, count)})`;
}

/**
 * Seeds a fixed library for the per-worker user: tracks (shared table, namespaced
 * URIs), ratings + labels + track_labels (user-scoped, cascade on user delete).
 * Designed to exercise search (title/artist/label) and both filters (rating, label).
 */
export async function seedLibrary(userId: string, workerIndex: number): Promise<void> {
  const sql = getDb();
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
      INSERT INTO ratings (user_id, spotify_track_uri, rating_stars)
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

// --- Top-list seed (Spotify "Most listened") -------------------------------
// user_top_tracks / user_top_artists cascade on user delete, so these need no
// dedicated cleanup. The rank-1 track is deliberately NOT in the library (no
// tracks/ratings row) to exercise the not-yet-in-library render + name fallback.

export function topOnlyTrackUri(workerIndex: number): string {
  const id = `TopOnlyAnthem${String(workerIndex).padStart(4, '0')}`.padEnd(22, '0').slice(0, 22);
  return `spotify:track:${id}`;
}

export const TOP_ONLY_TRACK_NAME = 'Top Only Anthem';

/**
 * Seeds the user's Spotify top tracks (most-listened order):
 *   rank 1 → a track NOT in the library (name fallback, no rating)
 *   rank 2 → Midnight City (slot 0, rated 5)
 *   rank 3 → Levitating   (slot 2, rated 3)
 * Requires seedLibrary to have run first for the rank-2/3 metadata.
 */
export async function seedTopTracks(userId: string, workerIndex: number): Promise<void> {
  const sql = getDb();
  const rows: { rank: number; uri: string; name: string }[] = [
    { rank: 1, uri: topOnlyTrackUri(workerIndex), name: TOP_ONLY_TRACK_NAME },
    { rank: 2, uri: trackUri(workerIndex, 0), name: 'Midnight City' },
    { rank: 3, uri: trackUri(workerIndex, 2), name: 'Levitating' },
  ];
  for (const r of rows) {
    await sql`
      INSERT INTO user_top_tracks (user_id, rank, spotify_track_uri, name)
      VALUES (${userId}, ${r.rank}, ${r.uri}, ${r.name})
    `;
  }
}

/**
 * Seeds the user's Spotify top artists (most-listened order):
 *   rank 1 → Pink Floyd (NOT in the library → "Not rated yet")
 *   rank 2 → M83        (in the library)
 *   rank 3 → deadmau5   (in the library)
 */
export async function seedTopArtists(userId: string): Promise<void> {
  const sql = getDb();
  const rows: { rank: number; id: string; name: string }[] = [
    { rank: 1, id: 'artist-pink-floyd', name: 'Pink Floyd' },
    { rank: 2, id: 'artist-m83', name: 'M83' },
    { rank: 3, id: 'artist-deadmau5', name: 'deadmau5' },
  ];
  for (const r of rows) {
    await sql`
      INSERT INTO user_top_artists (user_id, rank, spotify_artist_id, name)
      VALUES (${userId}, ${r.rank}, ${r.id}, ${r.name})
    `;
  }
}

/**
 * Seeds a fresh (non-expired) Spotify token row so getValidAccessToken returns
 * an access token without hitting Spotify's refresh endpoint. The access token
 * is fake — any actual Spotify call (e.g. listTopTracks' metadata hydration)
 * will 401 and be swallowed — but it's enough to exercise the token-present
 * code path that a tokenless test user can't reach.
 */
export async function seedSpotifyToken(userId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO spotify_tokens (user_id, refresh_token_enc, access_token, expires_at)
    VALUES (${userId}, ${Buffer.from([0])}, ${'fake-access-token'}, ${new Date(Date.now() + 3_600_000)})
    ON CONFLICT (user_id) DO UPDATE
      SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at
  `;
}

// A standalone multi-artist track for the artist-link drawer spec. Namespaced by
// worker like the fixture tracks, but kept OUT of LIBRARY_FIXTURE so it doesn't
// perturb the artist-count assertions in library.spec.
function multiArtistUri(workerIndex: number): string {
  const id = `MultiArtist${String(workerIndex).padStart(4, '0')}`.padEnd(22, '0').slice(0, 22);
  return `spotify:track:${id}`;
}

export const MULTI_ARTIST_NAMES = ['Calvin Harris', 'Rihanna'];

/** Seeds one multi-artist track (rated, so it surfaces on the track-detail page). */
export async function seedMultiArtistTrack(userId: string, workerIndex: number): Promise<string> {
  const sql = getDb();
  const uri = multiArtistUri(workerIndex);
  await sql`
    INSERT INTO tracks (spotify_track_uri, title, artists, album_art_url)
    VALUES (${uri}, ${'This Is What You Came For'}, ${MULTI_ARTIST_NAMES}, ${null})
    ON CONFLICT (spotify_track_uri) DO UPDATE
      SET title = EXCLUDED.title, artists = EXCLUDED.artists
  `;
  await sql`
    INSERT INTO ratings (user_id, spotify_track_uri, rating_stars)
    VALUES (${userId}, ${uri}, ${4})
  `;
  return uri;
}

export async function cleanupMultiArtistTrack(workerIndex: number): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM tracks WHERE spotify_track_uri = ${multiArtistUri(workerIndex)}`;
}

/** Deletes the worker's seeded tracks rows (tracks does NOT cascade on user delete). */
export async function cleanupLibrary(workerIndex: number): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM tracks WHERE spotify_track_uri = ANY(${libraryTrackUris(workerIndex)})`;
}

// --- Discovery seed (track_similars) ----------------------------------------
// Similars hang off the worker's library tracks; the table is not user-scoped
// and doesn't cascade, so cleanup deletes by the seeding tracks' URIs.

export function discoveryTrackUri(workerIndex: number, i: number): string {
  const id = `DISC${String(workerIndex).padStart(2, '0')}${String(i).padStart(4, '0')}`
    .padEnd(22, '0')
    .slice(0, 22);
  return `spotify:track:${id}`;
}

/**
 * Discovery pool fixture, exercising every rule of the loader:
 *   - two fresh similars off the 5★/4★ seeds → the pool (dupe similar collapses)
 *   - a similar that's already rated → excluded
 *   - a similar seeded only by a 3★ track → below the 4★ seed cutoff, excluded
 * Net pool for the worker: 2 tracks.
 */
export async function seedSimilars(workerIndex: number): Promise<void> {
  const sql = getDb();
  const rows = [
    { from: trackUri(workerIndex, 0), to: discoveryTrackUri(workerIndex, 0), match: 0.9 },
    { from: trackUri(workerIndex, 0), to: discoveryTrackUri(workerIndex, 1), match: 0.6 },
    { from: trackUri(workerIndex, 1), to: discoveryTrackUri(workerIndex, 0), match: 0.8 },
    { from: trackUri(workerIndex, 1), to: trackUri(workerIndex, 2), match: 0.7 },
    { from: trackUri(workerIndex, 2), to: discoveryTrackUri(workerIndex, 2), match: 0.9 },
  ];
  for (const r of rows) {
    await sql`
      INSERT INTO track_similars (spotify_track_uri, similar_uri, match_score)
      VALUES (${r.from}, ${r.to}, ${r.match})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function cleanupSimilars(workerIndex: number): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM track_similars WHERE spotify_track_uri = ANY(${libraryTrackUris(workerIndex)})`;
}

// --- History seed (recent plays) -------------------------------------------
// Seeds the local `plays` log so the History view can be exercised without a
// Spotify token (the view degrades to in-app plays when none is present). Adds
// one UNRATED track (catalog row, no rating) plus plays for it, and a play for
// an already-rated library track — so the Unrated filter and All filter differ.
export function historyUnratedTrackUri(workerIndex: number): string {
  const id = `HistUnrated${String(workerIndex).padStart(4, '0')}`.padEnd(22, '0').slice(0, 22);
  return `spotify:track:${id}`;
}
export const HISTORY_UNRATED_TITLE = 'Unrated Recent Jam';

/** Requires seedLibrary first (for the rated track). Returns the seeded URIs. */
export async function seedHistoryPlays(
  userId: string,
  workerIndex: number,
): Promise<{ unratedUri: string; ratedUri: string }> {
  const sql = getDb();
  const unratedUri = historyUnratedTrackUri(workerIndex);
  const ratedUri = trackUri(workerIndex, 0); // "Midnight City" (rating 5 from seedLibrary)

  await sql`
    INSERT INTO tracks (spotify_track_uri, title, artists, album_art_url)
    VALUES (${unratedUri}, ${HISTORY_UNRATED_TITLE}, ${['Fresh Artist']}, ${null})
    ON CONFLICT (spotify_track_uri) DO UPDATE
      SET title = EXCLUDED.title, artists = EXCLUDED.artists
  `;

  // Recent plays, all inside the 7-day window.
  await sql`INSERT INTO plays (user_id, spotify_track_uri, played_at, source)
            VALUES (${userId}, ${unratedUri}, now() - interval '10 minutes', 'shuffle')`;
  await sql`INSERT INTO plays (user_id, spotify_track_uri, played_at, source)
            VALUES (${userId}, ${unratedUri}, now() - interval '2 hours', 'shuffle')`;
  await sql`INSERT INTO plays (user_id, spotify_track_uri, played_at, source)
            VALUES (${userId}, ${ratedUri}, now() - interval '1 hour', 'manual')`;

  return { unratedUri, ratedUri };
}

/** plays cascade on user delete; only the non-cascading unrated track needs cleanup. */
export async function cleanupHistoryPlays(workerIndex: number): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM tracks WHERE spotify_track_uri = ${historyUnratedTrackUri(workerIndex)}`;
}

export async function closeSeedConnection(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}
