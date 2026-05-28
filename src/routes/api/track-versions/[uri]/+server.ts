import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { findTrackVersions } from '$lib/server/track-versions';

export const GET: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const uri = decodeURIComponent(params.uri);
  if (!uri.startsWith('spotify:track:')) throw error(400, 'invalid track uri');

  const result = await findTrackVersions(locals.user.id, uri);
  return json(result, { headers: { 'cache-control': 'no-store' } });
};
