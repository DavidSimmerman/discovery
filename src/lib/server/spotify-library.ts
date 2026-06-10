// Liked Songs bridge: a rating of 2+ stars means the user wants the track in
// their Spotify library too. Best-effort and quiet by design — the rating is
// the source of truth and is already saved; failing to mirror it into Liked
// Songs (missing user-library-modify scope on an old session, rate limit,
// network) must never surface as a rating error.
//
// We check /me/tracks/contains first instead of blindly PUTting: re-saving an
// already-liked track bumps its added_at, which silently reorders the user's
// Liked Songs playlist. Downgrades below 2 stars do NOT remove — unliking is
// a bigger action than we're authorized to infer from a rating tweak.

import { getValidAccessToken } from '$lib/server/tokens';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const TRACK_URI_RE = /^spotify:track:([A-Za-z0-9]{22})$/;

export async function ensureSavedTrack(userId: string, trackUri: string): Promise<void> {
  const id = TRACK_URI_RE.exec(trackUri)?.[1];
  if (!id) return;

  try {
    const { access_token } = await getValidAccessToken(userId);

    const contains = await fetch(
      `https://api.spotify.com/v1/me/tracks/contains?ids=${id}`,
      { headers: { authorization: `Bearer ${access_token}` } },
    );
    // Can't verify → don't write. A blind PUT on an already-liked track would
    // reorder Liked Songs (see header comment).
    if (!contains.ok) {
      console.warn('[likedSync] contains check failed', { userId, status: contains.status });
      return;
    }
    const [alreadySaved] = (await contains.json()) as boolean[];
    if (alreadySaved) return;

    const save = await fetch('https://api.spotify.com/v1/me/tracks', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ids: [id] }),
    });

    // 403 here means the stored token predates the user-library-modify scope
    // (the contains check above still works — user-library-read is an older
    // grant). Flag the user for re-auth (matching history/top-lists) so the
    // next navigation bounces them through OAuth instead of silently never
    // mirroring ratings into Liked Songs.
    if (!save.ok) {
      console.warn('[likedSync] save failed', { userId, status: save.status });
    }
    if (save.status === 403) {
      try {
        await db.update(users).set({ needsReauth: true }).where(eq(users.id, userId));
      } catch (markErr) {
        console.error('[ensureSavedTrack] failed to flag user for re-auth', { userId, markErr });
      }
    }
  } catch {
    /* best-effort — see header comment */
  }
}
