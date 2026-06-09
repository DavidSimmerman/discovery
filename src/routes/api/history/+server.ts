import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listHistory } from '$lib/server/history';
import { getValidAccessToken } from '$lib/server/tokens';

// Recent listening history (Spotify recently-played + in-app plays), deduped and
// joined to ratings. Defaults to unrated tracks; ?includeRated=1 returns all so
// existing ratings can be revisited. ?count=1 returns only the unrated badge
// count (still does the merge, but skips shipping the full row list).
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const includeRated = url.searchParams.get('includeRated') === '1';
  const countOnly = url.searchParams.get('count') === '1';

  // Best-effort token: a hiccup degrades the view to in-app plays rather than
  // 500ing. The history merge tolerates a null token.
  const accessToken = await getValidAccessToken(locals.user.id)
    .then((t) => t.access_token)
    .catch(() => null);

  const { rows, unratedCount } = await listHistory(locals.user.id, accessToken, {
    // Count-only never needs rated rows; it just wants the unrated total.
    includeRated: countOnly ? false : includeRated,
  });

  const body = countOnly ? { unratedCount } : { rows, unratedCount };
  return json(body, { headers: { 'cache-control': 'no-store' } });
};
