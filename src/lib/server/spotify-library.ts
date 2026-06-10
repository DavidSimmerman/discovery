// Liked Songs bridge: a rating of 2+ stars means the user wants the track in
// their Spotify library too. Best-effort and quiet by design — the rating is
// the source of truth and is already saved; failing to mirror it into Liked
// Songs (rate limit, network, missing scope) must never surface as a rating
// error.
//
// Endpoints: the Feb-2026 migration REMOVED the legacy library surface for
// dev-mode apps — /me/tracks/contains and PUT /me/tracks both return a bare
// 403 Forbidden now (verified live 2026-06-10). The replacement is the
// unified /me/library family addressed by full Spotify URIs:
//   GET /me/library/contains?uris=...   (max 40)
//   PUT /me/library?uris=...            (query shape; the migration guide
//                                        also shows a JSON-body shape, so we
//                                        fall back to that on a 400)
//
// We check contains first instead of blindly PUTting: re-saving an already-
// liked track bumps its added_at, which silently reorders the user's Liked
// Songs. Downgrades below 2 stars do NOT remove — unliking is a bigger action
// than we're authorized to infer from a rating tweak.

import { getValidAccessToken } from '$lib/server/tokens';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;

export async function ensureSavedTrack(userId: string, trackUri: string): Promise<void> {
  if (!TRACK_URI_RE.test(trackUri)) return;

  try {
    const { access_token } = await getValidAccessToken(userId);
    const auth = { authorization: `Bearer ${access_token}` };

    const contains = await fetch(
      `https://api.spotify.com/v1/me/library/contains?uris=${encodeURIComponent(trackUri)}`,
      { headers: auth },
    );
    // Can't verify → don't write. A blind PUT on an already-liked track would
    // reorder Liked Songs (see header comment).
    if (!contains.ok) {
      console.warn('[likedSync] contains check failed', { userId, status: contains.status });
      return;
    }
    const [alreadySaved] = (await contains.json()) as boolean[];
    if (alreadySaved) return;

    let save = await fetch(
      `https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(trackUri)}`,
      { method: 'PUT', headers: auth },
    );
    if (save.status === 400) {
      // Doc-ambiguity fallback: the migration guide shows a JSON-body shape.
      save = await fetch('https://api.spotify.com/v1/me/library', {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ uris: [trackUri] }),
      });
    }
    if (!save.ok) {
      console.warn('[likedSync] save failed', { userId, status: save.status });
    }

    // On the unified endpoint a 403 means insufficient scope (the legacy
    // bare-403s came from the REMOVED endpoints — don't confuse the two).
    // Flag the user for re-auth (matching history/top-lists) so the next
    // navigation bounces them through OAuth instead of silently never
    // mirroring ratings into Liked Songs.
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
