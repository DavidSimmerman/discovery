import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listLabels, appliedLabelIds } from '$lib/server/labels';

const TRACK_URI_RE = /^spotify:track:[A-Za-z0-9]{22}$/;

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const trackUri = url.searchParams.get('trackUri');
  const labels = await listLabels(locals.user.id);

  if (trackUri !== null) {
    if (!TRACK_URI_RE.test(trackUri)) {
      throw error(400, 'invalid trackUri');
    }
    const applied = await appliedLabelIds(locals.user.id, trackUri);
    const appliedSet = new Set(applied);
    return json(
      {
        labels: labels.map((label) => ({
          id: label.id,
          name: label.name,
          applied: appliedSet.has(label.id),
        })),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  return json(
    { labels: labels.map((label) => ({ id: label.id, name: label.name })) },
    { headers: { 'cache-control': 'no-store' } },
  );
};
