import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchSpotifyMe } from '$lib/server/spotify';
import { getValidAccessToken } from '$lib/server/tokens';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const { access_token } = await getValidAccessToken(locals.user.id);
  const me = await fetchSpotifyMe(access_token);
  return json(me);
};
