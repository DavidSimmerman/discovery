import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getValidAccessToken } from '$lib/server/tokens';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const { access_token, expires_at } = await getValidAccessToken(locals.user.id);

  return json({ access_token, expires_at: expires_at.getTime() });
};
