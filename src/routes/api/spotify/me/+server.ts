import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchSpotifyMe } from '$lib/server/spotify';

export const GET: RequestHandler = async ({ locals, fetch }) => {
  if (!locals.user) throw error(401, 'not logged in');
  // Reuse the access-token endpoint via internal fetch to dodge refresh logic duplication.
  const tokRes = await fetch('/api/spotify/access-token');
  if (!tokRes.ok) throw error(tokRes.status, 'token unavailable');
  const { access_token } = await tokRes.json();
  const me = await fetchSpotifyMe(access_token);
  return json(me);
};
