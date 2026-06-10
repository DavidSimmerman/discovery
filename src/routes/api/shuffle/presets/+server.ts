// Named shuffle presets — snapshots of the full ShuffleSettings blob.
//
// GET  → { presets: [{ id, name, updatedAt }] }       (list, no configs)
// POST { name, settings? } → { preset }               (create; settings
//        omitted = snapshot the user's current saved settings)
//
// Names are unique per user (DB constraint) → 409 on a duplicate.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { shufflePresets } from '$lib/server/db/schema';
import { normalizeSettings } from '$lib/server/shuffle/config';
import { isUniqueViolation, validPresetName } from '$lib/server/shuffle/presets';
import { loadUserSettings, withUserSessionLock } from '$lib/server/shuffle/session-store';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const presets = await db
    .select({
      id: shufflePresets.id,
      name: shufflePresets.name,
      updatedAt: shufflePresets.updatedAt,
    })
    .from(shufflePresets)
    .where(eq(shufflePresets.userId, locals.user.id))
    .orderBy(desc(shufflePresets.updatedAt));
  return json({ presets });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    settings?: unknown;
  } | null;
  if (body == null || typeof body !== 'object') throw error(400, 'body required');
  const name = validPresetName(body.name);

  // Explicit settings (the client's live edit) or the saved ones.
  const settings =
    body.settings !== undefined
      ? normalizeSettings(body.settings)
      : await withUserSessionLock(userId, (tx) => loadUserSettings(tx, userId));

  try {
    const rows = await db
      .insert(shufflePresets)
      .values({ userId, name, config: settings })
      .returning({
        id: shufflePresets.id,
        name: shufflePresets.name,
        updatedAt: shufflePresets.updatedAt,
      });
    return json({ preset: rows[0] }, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) throw error(409, 'a preset with that name already exists');
    throw err;
  }
};
