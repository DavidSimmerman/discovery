import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { enrichUserLibrary } from '$lib/server/shuffle/enrichment';
import { getValidAccessToken } from '$lib/server/tokens';

// Kick off backfill for the authenticated user. Fire-and-forget — the run can
// take minutes (MusicBrainz is 1 req/s); we return 202 immediately and let the
// status endpoint report progress.
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const userId = locals.user.id;

  const { access_token } = await getValidAccessToken(userId);

  // Fire-and-forget. Failures land in logs.
  void enrichUserLibrary(userId, access_token).catch((err) => {
    console.error('[enrichment] run failed', userId, err);
  });

  return json({ started: true }, { status: 202 });
};
