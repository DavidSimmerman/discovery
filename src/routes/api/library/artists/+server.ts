import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listArtists } from '$lib/server/library';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const rows = await listArtists(locals.user.id);
  return json({ rows }, { headers: { 'cache-control': 'no-store' } });
};
