import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
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
