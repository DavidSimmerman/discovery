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
import { ratings } from '$lib/server/db/schema';
import { normalizeSettings } from '$lib/server/shuffle/config';
import { discoveryPoolCount } from '$lib/server/shuffle/sources';
import {
  loadUserSettings,
  saveUserSettings,
  withUserSessionLock,
} from '$lib/server/shuffle/session-store';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  // libraryCount/discoveryCount feed the source cards' subtitles.
  const [settings, counted, discoveryCount] = await Promise.all([
    withUserSessionLock(userId, (tx) => loadUserSettings(tx, userId)),
    db.select({ n: count() }).from(ratings).where(eq(ratings.userId, userId)),
    discoveryPoolCount(db, userId),
  ]);
  return json({ settings, libraryCount: counted[0]?.n ?? 0, discoveryCount });
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
    return json({ settings });
  });
};
