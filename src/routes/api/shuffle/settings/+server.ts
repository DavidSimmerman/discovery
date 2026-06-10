// Read/write the user's shuffle settings (sources + sampler knobs).
//
// GET → { settings }
// PUT { settings } → { settings } (normalized form echoed back)
//
// PUT runs the payload through normalizeSettings, the same fold used when
// loading persisted rows — malformed playlist entries are dropped rather than
// rejected, so the stored blob is always loadable.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { count, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { ratings, shuffleSessions } from '$lib/server/db/schema';
import { normalizeSettings } from '$lib/server/shuffle/config';
import { discoveryPoolCount } from '$lib/server/shuffle/sources';
import {
  loadUserSettings,
  saveUserSettings,
  withUserSessionLock,
} from '$lib/server/shuffle/session-store';
import { autoEnrichIfBehind } from '$lib/server/shuffle/enrichment';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  // Opening shuffle settings is the natural catch-up point for the enrichment
  // backfill (artist/genre filter options are empty until it runs). Guarded +
  // fire-and-forget inside autoEnrichIfBehind.
  void autoEnrichIfBehind(userId);
  // libraryCount/discoveryCount feed the source cards' subtitles; presetId
  // lets the header pill highlight the preset the session was applied from.
  // settings + presetId read under the same lock so a racing PUT/apply can't
  // pair one's settings with the other's preset link.
  const [session, counted, discoveryCount] = await Promise.all([
    withUserSessionLock(userId, async (tx) => {
      const [settings, rows] = await Promise.all([
        loadUserSettings(tx, userId),
        tx
          .select({ presetId: shuffleSessions.presetId })
          .from(shuffleSessions)
          .where(eq(shuffleSessions.userId, userId))
          .limit(1),
      ]);
      return { settings, presetId: rows[0]?.presetId ?? null };
    }),
    db.select({ n: count() }).from(ratings).where(eq(ratings.userId, userId)),
    discoveryPoolCount(db, userId),
  ]);
  return json({
    settings: session.settings,
    libraryCount: counted[0]?.n ?? 0,
    discoveryCount,
    presetId: session.presetId,
  });
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;

  const body = (await request.json().catch(() => null)) as { settings?: unknown } | null;
  if (body == null || typeof body !== 'object' || !('settings' in body)) {
    throw error(400, 'settings required');
  }
  const settings = normalizeSettings(body.settings);

  return await withUserSessionLock(userId, async (tx) => {
    await saveUserSettings(tx, userId, settings);
    // A manual settings save diverges from whatever preset was applied —
    // drop the link so the UI doesn't claim the preset is still active.
    // (Preset apply runs its own path and re-links afterwards.)
    await tx
      .update(shuffleSessions)
      .set({ presetId: null })
      .where(eq(shuffleSessions.userId, userId));
    return json({ settings });
  });
};
