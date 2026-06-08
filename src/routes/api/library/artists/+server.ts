import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listArtists, listTopArtists } from '$lib/server/library';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');
  // ?sort=listens → Spotify top artists (most-listened order, may include
  // artists not yet in the library). Anything else → the rated-library list,
  // which the client sorts further on its own.
  const rows =
    url.searchParams.get('sort') === 'listens'
      ? await listTopArtists(locals.user.id)
      : await listArtists(locals.user.id);
  return json({ rows }, { headers: { 'cache-control': 'no-store' } });
};
