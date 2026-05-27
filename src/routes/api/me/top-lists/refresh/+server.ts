import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  getLastRefreshedAt,
  isStale,
  refreshUserTopListsInBackground,
} from '$lib/server/top-lists';

// Idempotent: callable on every app load. Checks staleness internally so the
// frontend can fire-and-forget without worrying about thrash. Refresh itself
// runs in the background; this endpoint returns immediately.
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const lastAt = await getLastRefreshedAt(locals.user.id);
  if (isStale(lastAt)) {
    refreshUserTopListsInBackground(locals.user.id);
    return json({ refreshing: true, lastRefreshedAt: lastAt });
  }
  return json({ refreshing: false, lastRefreshedAt: lastAt });
};
