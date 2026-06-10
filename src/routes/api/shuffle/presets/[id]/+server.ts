// Single-preset operations.
//
// PUT    { name?, settings? } → { preset }   rename and/or overwrite the blob
// DELETE                      → { ok: true } (active sessions keep playing —
//                               shuffle_sessions.preset_id is ON DELETE SET NULL)

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { shufflePresets } from '$lib/server/db/schema';
import { normalizeSettings } from '$lib/server/shuffle/config';
import {
  isUniqueViolation,
  validPresetId,
  validPresetName,
} from '$lib/server/shuffle/presets';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const id = validPresetId(params.id);

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    settings?: unknown;
  } | null;
  if (body == null || typeof body !== 'object') throw error(400, 'body required');
  if (body.name === undefined && body.settings === undefined) {
    throw error(400, 'nothing to update');
  }

  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (body.name !== undefined) set.name = validPresetName(body.name);
  if (body.settings !== undefined) set.config = normalizeSettings(body.settings);

  try {
    const rows = await db
      .update(shufflePresets)
      .set(set)
      .where(and(eq(shufflePresets.id, id), eq(shufflePresets.userId, locals.user.id)))
      .returning({
        id: shufflePresets.id,
        name: shufflePresets.name,
        updatedAt: shufflePresets.updatedAt,
      });
    if (rows.length === 0) throw error(404, 'no such preset');
    return json({ preset: rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) throw error(409, 'a preset with that name already exists');
    throw err;
  }
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const id = validPresetId(params.id);
  const rows = await db
    .delete(shufflePresets)
    .where(and(eq(shufflePresets.id, id), eq(shufflePresets.userId, locals.user.id)))
    .returning({ id: shufflePresets.id });
  if (rows.length === 0) throw error(404, 'no such preset');
  return json({ ok: true });
};
