// Shared bits of the preset endpoints (route files can only export verbs).

import { error } from '@sveltejs/kit';

export const PRESET_NAME_MAX = 60;

// Trimmed, non-empty, sane length — or a 400.
export function validPresetName(raw: unknown): string {
  if (typeof raw !== 'string') throw error(400, 'name required');
  const name = raw.trim();
  if (name.length === 0) throw error(400, 'name required');
  if (name.length > PRESET_NAME_MAX) throw error(400, `name longer than ${PRESET_NAME_MAX} chars`);
  return name;
}

// Postgres unique-violation → the user already has a preset with this name.
// Drizzle wraps driver errors (DrizzleQueryError.cause), so walk the chain.
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === '23505') return true;
  }
  return false;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Route [id] params arrive as arbitrary strings; a non-UUID can't be a
// preset, and letting it through would 500 on the uuid cast instead of 404.
export function validPresetId(id: string | undefined): string {
  if (id == null || !UUID_RE.test(id)) throw error(404, 'no such preset');
  return id;
}
