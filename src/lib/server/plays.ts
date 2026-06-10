// Plays ingestion. The `plays` table is the append-only listening log that
// powers per-track play counts (library/artist views) and the cooldown safety
// net — but until 2026-06-10 nothing ever WROTE to it, so every count in the
// app read 0 from an empty table.
//
// Source of truth: Spotify's own recently-played feed (tracks played >30s,
// rolling last-50 window, exact played_at timestamps). That covers all real
// listening — shuffle, manual, the Spotify app itself — with one ingestion
// path and no double counting. Dedupe is structural: a unique index on
// (user_id, track, played_at) + ON CONFLICT DO NOTHING makes re-ingesting the
// same window a no-op.
//
// Two entry points:
//   - ingestSpotifyPlays: called by listHistory with the items it already
//     fetched (no extra Spotify call).
//   - maybeIngestRecentPlays: cooldown-guarded fire-and-forget for hot paths
//     (the currently-playing poll), so the log stays dense while the app is
//     open even if the user never visits /history.

import { db } from '$lib/server/db';
import { plays } from '$lib/server/db/schema';
import { getValidAccessToken } from '$lib/server/tokens';
import { fetchRecentlyPlayed, type RecentlyPlayedItem } from '$lib/server/spotify';

const INGEST_COOLDOWN_MS = 5 * 60_000;
const lastIngestAt = new Map<string, number>();

export async function ingestSpotifyPlays(
  userId: string,
  items: readonly RecentlyPlayedItem[],
): Promise<void> {
  const values = items
    .map((i) => ({
      userId,
      spotifyTrackUri: i.track.uri,
      playedAt: new Date(i.played_at),
      source: 'spotify',
    }))
    .filter((v) => !Number.isNaN(v.playedAt.getTime()));
  if (values.length === 0) return;
  await db
    .insert(plays)
    .values(values)
    .onConflictDoNothing({
      target: [plays.userId, plays.spotifyTrackUri, plays.playedAt],
    });
}

export async function maybeIngestRecentPlays(userId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastIngestAt.get(userId) ?? 0) < INGEST_COOLDOWN_MS) return;
  lastIngestAt.set(userId, now);
  try {
    const { access_token } = await getValidAccessToken(userId);
    const items = await fetchRecentlyPlayed(access_token);
    await ingestSpotifyPlays(userId, items);
  } catch (err) {
    // Best-effort: counts catch up on the next window. Don't release the
    // cooldown — a hard failure (revoked token) would otherwise retry per poll.
    console.warn('[plays] recent-plays ingest failed', { userId, err: String(err) });
  }
}

export function _resetPlaysIngestCooldownForTests(): void {
  lastIngestAt.clear();
}
