// Apply a preset: copy its settings into the user's live shuffle settings
// (shuffle_sessions.activeConfig) and link the session to the preset.
//
// POST → { settings }  — the normalized settings now active; the client
// replaces its local state with these.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { shufflePresets, shuffleSessions } from '$lib/server/db/schema';
import { normalizeSettings } from '$lib/server/shuffle/config';
import { validPresetId } from '$lib/server/shuffle/presets';
import { saveUserSettings, withUserSessionLock } from '$lib/server/shuffle/session-store';

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;
  const id = validPresetId(params.id);

  const rows = await db
    .select({ config: shufflePresets.config })
    .from(shufflePresets)
    .where(and(eq(shufflePresets.id, id), eq(shufflePresets.userId, userId)));
  if (rows.length === 0) throw error(404, 'no such preset');

  // Old presets fold forward exactly like persisted activeConfig blobs do.
  const settings = normalizeSettings(rows[0].config);

  return await withUserSessionLock(userId, async (tx) => {
    await saveUserSettings(tx, userId, settings);
    await tx
      .update(shuffleSessions)
      .set({ presetId: id, updatedAt: sql`now()` })
      .where(eq(shuffleSessions.userId, userId));
    return json({ settings });
  });
};
