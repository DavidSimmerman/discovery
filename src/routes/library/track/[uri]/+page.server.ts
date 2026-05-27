import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getLibraryTrack } from '$lib/server/library';

export const load: PageServerLoad = async ({ locals, params }) => {
  if (!locals.user) throw redirect(303, '/');
  const uri = decodeURIComponent(params.uri);
  const track = await getLibraryTrack(locals.user.id, uri);
  if (!track) throw error(404, 'Track not in your library');
  return { track };
};
