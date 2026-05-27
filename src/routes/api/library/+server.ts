import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLibrary, libraryFacets, type LibrarySort } from '$lib/server/library';

const VALID_SORTS: readonly LibrarySort[] = ['recency', 'rating', 'name', 'artist'];

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const opts: {
    search?: string;
    minRating?: number;
    label?: string;
    artist?: string;
    sort?: LibrarySort;
  } = {};

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

  const rawArtist = url.searchParams.get('artist');
  if (rawArtist !== null) {
    const trimmed = rawArtist.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > 200) throw error(400, 'artist too long');
      opts.artist = trimmed;
    }
  }

  const rawSort = url.searchParams.get('sort');
  if (rawSort !== null && rawSort.length > 0) {
    if (!VALID_SORTS.includes(rawSort as LibrarySort)) {
      throw error(400, 'invalid sort');
    }
    opts.sort = rawSort as LibrarySort;
  }

  const [rows, facets] = await Promise.all([
    listLibrary(locals.user.id, opts),
    libraryFacets(locals.user.id),
  ]);

  return json({ rows, facets }, { headers: { 'cache-control': 'no-store' } });
};
