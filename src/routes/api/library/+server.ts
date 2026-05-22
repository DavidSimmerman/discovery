import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLibrary, libraryFacets } from '$lib/server/library';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const opts: { search?: string; minRating?: number; label?: string } = {};

  const rawSearch = url.searchParams.get('search');
  if (rawSearch !== null) {
    const trimmed = rawSearch.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 100) throw error(400, 'search too long');
      opts.search = trimmed;
    }
  }

  const rawMinRating = url.searchParams.get('minRating');
  if (rawMinRating !== null && rawMinRating.length > 0) {
    const minRating = Number(rawMinRating);
    if (!Number.isInteger(minRating) || minRating < 1 || minRating > 10) {
      throw error(400, 'minRating must be an integer between 1 and 10');
    }
    opts.minRating = minRating;
  }

  const rawLabel = url.searchParams.get('label');
  if (rawLabel !== null) {
    const trimmed = rawLabel.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 50) throw error(400, 'label too long');
      opts.label = trimmed;
    }
  }

  const [rows, facets] = await Promise.all([
    listLibrary(locals.user.id, opts),
    libraryFacets(locals.user.id),
  ]);

  return json({ rows, facets }, { headers: { 'cache-control': 'no-store' } });
};
