import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  listLibrary,
  listLibraryUris,
  listTopTracks,
  libraryFacets,
  type LibraryRow,
  type LibrarySort,
  type LibraryTab,
} from '$lib/server/library';
import { getValidAccessToken } from '$lib/server/tokens';

const VALID_SORTS: readonly LibrarySort[] = [
  'recency',
  'rating',
  'name',
  'artist',
  'top',
  'listens',
];

const VALID_TABS: readonly LibraryTab[] = ['all', 'rated', 'labeled'];

// Hard ceiling on a single page so a crafted ?limit can't ask for the whole table.
const MAX_LIMIT = 100;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const opts: {
    search?: string;
    minRating?: number;
    label?: string;
    artist?: string;
    sort?: LibrarySort;
    tab?: LibraryTab;
    limit?: number;
    offset?: number;
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

  const rawTab = url.searchParams.get('tab');
  if (rawTab !== null && rawTab.length > 0) {
    if (!VALID_TABS.includes(rawTab as LibraryTab)) {
      throw error(400, 'invalid tab');
    }
    if (rawTab !== 'all') opts.tab = rawTab as LibraryTab;
  }

  const rawLimit = url.searchParams.get('limit');
  if (rawLimit !== null && rawLimit.length > 0) {
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw error(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    opts.limit = limit;
  }

  const rawOffset = url.searchParams.get('offset');
  if (rawOffset !== null && rawOffset.length > 0) {
    const offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0) {
      throw error(400, 'offset must be a non-negative integer');
    }
    opts.offset = offset;
  }

  // Shuffle needs every URI matching the current tab + filters, not just the
  // pages scrolled into view. ?uris=1 returns that uncapped id list and nothing
  // else (sort is irrelevant — shuffle randomizes). Not supported for "Most
  // listened", whose ≤50 rows are already fully loaded client-side.
  if (url.searchParams.get('uris') === '1') {
    const uris = await listLibraryUris(locals.user.id, {
      search: opts.search,
      minRating: opts.minRating,
      label: opts.label,
      artist: opts.artist,
      tab: opts.tab,
    });
    return json({ uris }, { headers: { 'cache-control': 'no-store' } });
  }

  // "Most listened" is served from the cached Spotify top-tracks snapshot (which
  // can include not-yet-in-library tracks), not the library listing. Hydrating
  // metadata for not-yet-cached tracks needs an access token; fetch one
  // best-effort so a token hiccup degrades to a name-only render rather than 500.
  // It's a fixed ≤50 snapshot (no pagination), so its total is just the row count;
  // the library listing is paginated and returns its own uncapped total instead.
  const listingPromise: Promise<{ rows: LibraryRow[]; total: number }> =
    opts.sort === 'listens'
      ? getValidAccessToken(locals.user.id)
          .then((t) => t.access_token)
          .catch(() => null)
          .then((accessToken) => listTopTracks(locals.user!.id, accessToken, { search: opts.search }))
          .then((rows) => ({ rows, total: rows.length }))
      : listLibrary(locals.user.id, opts);

  const [{ rows, total }, facets] = await Promise.all([
    listingPromise,
    libraryFacets(locals.user.id),
  ]);

  return json({ rows, total, facets }, { headers: { 'cache-control': 'no-store' } });
};
