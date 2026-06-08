import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLibrary, listTopTracks, libraryFacets, type LibrarySort } from '$lib/server/library';
import { getValidAccessToken } from '$lib/server/tokens';

const VALID_SORTS: readonly LibrarySort[] = [
  'recency',
  'rating',
  'name',
  'artist',
  'top',
  'listens',
];

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
    if (!Number.isInteger(minRating) || minRating < 1 || minRating > 5) {
      throw error(400, 'minRating must be an integer between 1 and 5');
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

  // "Most listened" is served from the cached Spotify top-tracks snapshot (which
  // can include not-yet-in-library tracks), not the library listing. Hydrating
  // metadata for not-yet-cached tracks needs an access token; fetch one
  // best-effort so a token hiccup degrades to a name-only render rather than 500.
  const rowsPromise =
    opts.sort === 'listens'
      ? getValidAccessToken(locals.user.id)
          .then((t) => t.access_token)
          .catch(() => null)
          .then((accessToken) => listTopTracks(locals.user!.id, accessToken, { search: opts.search }))
      : listLibrary(locals.user.id, opts);

  const [rows, facets] = await Promise.all([rowsPromise, libraryFacets(locals.user.id)]);

  return json({ rows, facets }, { headers: { 'cache-control': 'no-store' } });
};
