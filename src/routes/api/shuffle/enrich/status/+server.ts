import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnrichmentStatus } from '$lib/server/shuffle/enrichment';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const status = await getEnrichmentStatus(locals.user.id);
  return json(status, { headers: { 'cache-control': 'no-store' } });
};
