// Cached snapshot of the user's Spotify top artists/tracks (long_term).
//
// Why cache rather than call Spotify live: we want the listening signal
// available to other readers — cross-user views ("see my friend's top
// artists") and backend playlist generators that score candidates against
// the owner's top lists, without needing the owner to be online.
//
// Refresh is triggered from the frontend on app load (stale > 24h) and
// fire-and-forget from the OAuth callback so a brand-new user has data
// available on their first visit.

import { db } from '$lib/server/db';
import { users, userTopArtists, userTopTracks } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getValidAccessToken } from '$lib/server/tokens';
import { fetchMyTopArtists, fetchMyTopTracks } from '$lib/server/spotify';

const STALE_MS = 24 * 60 * 60 * 1000;

export async function getTopArtistRank(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ rank: userTopArtists.rank, name: userTopArtists.name })
    .from(userTopArtists)
    .where(eq(userTopArtists.userId, userId));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.name.trim().toLowerCase(), r.rank);
  return out;
}

export async function getTopTrackRank(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ rank: userTopTracks.rank, uri: userTopTracks.spotifyTrackUri })
    .from(userTopTracks)
    .where(eq(userTopTracks.userId, userId));
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.uri, r.rank);
  return out;
}

export async function getLastRefreshedAt(userId: string): Promise<Date | null> {
  const row = await db
    .select({ at: users.topListsRefreshedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row[0]?.at ?? null;
}

export function isStale(lastRefreshedAt: Date | null, now: Date = new Date()): boolean {
  if (!lastRefreshedAt) return true;
  return now.getTime() - lastRefreshedAt.getTime() > STALE_MS;
}

// Fetch from Spotify and atomically replace the stored top lists.
// Throws if Spotify fails — caller decides whether to swallow.
export async function refreshUserTopLists(userId: string): Promise<void> {
  const { access_token } = await getValidAccessToken(userId);
  const [topArtists, topTracks] = await Promise.all([
    fetchMyTopArtists(access_token),
    fetchMyTopTracks(access_token),
  ]);

  await db.transaction(async (tx) => {
    await tx.delete(userTopArtists).where(eq(userTopArtists.userId, userId));
    await tx.delete(userTopTracks).where(eq(userTopTracks.userId, userId));

    if (topArtists.length > 0) {
      await tx.insert(userTopArtists).values(
        topArtists.map((a, i) => ({
          userId,
          rank: i + 1,
          spotifyArtistId: a.id,
          name: a.name,
        })),
      );
    }
    if (topTracks.length > 0) {
      await tx.insert(userTopTracks).values(
        topTracks.map((t, i) => ({
          userId,
          rank: i + 1,
          spotifyTrackUri: t.uri,
          name: t.name,
        })),
      );
    }
    await tx.update(users).set({ topListsRefreshedAt: new Date() }).where(eq(users.id, userId));
  });
}

// Fire-and-forget refresh that swallows errors. Use from OAuth callback and
// frontend-triggered staleness checks so a transient Spotify hiccup never
// blocks the user.
export function refreshUserTopListsInBackground(userId: string): void {
  void refreshUserTopLists(userId).catch((err) => {
    console.error('refreshUserTopLists failed', { userId, err });
  });
}
