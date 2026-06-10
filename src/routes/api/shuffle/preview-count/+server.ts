// Exact "Shuffle N songs" count for the settings the client is editing —
// loads candidates for the posted sources and applies the posted filters,
// without persisting anything. Playlist track lists are snapshot-cached, so
// repeat calls while editing are cheap.

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { effectiveSamplerConfig, normalizeSettings, poolSides } from '$lib/server/shuffle/config';
import { baseScore } from '$lib/server/shuffle/sampler';
import { loadCandidates, prefetchPlaylists } from '$lib/server/shuffle/sources';
import { getValidAccessToken } from '$lib/server/tokens';

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;

  const body = (await request.json().catch(() => null)) as { settings?: unknown } | null;
  if (body == null || typeof body !== 'object' || !('settings' in body)) {
    throw error(400, 'settings required');
  }
  const settings = normalizeSettings(body.settings);

  const token = await getValidAccessToken(userId).catch(() => null);
  const prefetched = await prefetchPlaylists(
    token?.access_token ?? null,
    userId,
    settings.sources,
  );

  // Read-only — no session lock needed; db serves the same select API as a tx.
  const candidates = await loadCandidates(db, userId, settings, prefetched);

  // Weight-0 knobs (tier bars / boost sliders at "never", mix-zeroed sides)
  // are permanent excludes, so they must come out of the advertised count.
  // Temporal gates (cooldowns, daily cap) stay in: those tracks are still part
  // of the pool, just not eligible right now.
  const cfg = effectiveSamplerConfig(settings, poolSides(settings.sources, settings.filters.rating.mode));
  const count = candidates.filter((c) => baseScore(c, cfg) > 0).length;
  return json({ count });
};
