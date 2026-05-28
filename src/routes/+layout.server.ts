import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
  // If a previous Spotify call returned 403/insufficient_scope, the user's
  // refresh token predates a scope we now require. Bounce them through OAuth
  // (skipping /auth/* itself to avoid a redirect loop).
  if (locals.user?.needsReauth && !url.pathname.startsWith('/auth')) {
    throw redirect(303, '/auth/login');
  }

  return {
    user: locals.user
      ? {
          id: locals.user.id,
          spotifyId: locals.user.spotifyId,
          displayName: locals.user.displayName,
          product: locals.user.product,
        }
      : null,
  };
};
