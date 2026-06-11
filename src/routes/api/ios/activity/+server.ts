import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { liveActivities } from '$lib/server/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

// Live Activity registration. The iOS app calls POST with the per-activity
// APNs push token (from ActivityKit's pushTokenUpdates) right after starting
// an activity; the server-side poller then keeps the lock screen current.
// DELETE ends tracking (e.g. the user dismissed the activity).

async function endActiveActivities(userId: string) {
  await db
    .update(liveActivities)
    .set({ endedAt: new Date() })
    .where(and(eq(liveActivities.userId, userId), isNull(liveActivities.endedAt)));
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) throw error(401, 'not logged in');
  const body = await request.json().catch(() => ({}));
  const apnsPushToken = body?.apnsPushToken;
  if (typeof apnsPushToken !== 'string' || !apnsPushToken) {
    throw error(400, 'apnsPushToken required');
  }
  // One active activity per user (enforced by partial unique index) — close
  // out any stale row first so re-registration after an app restart works.
  await endActiveActivities(locals.user.id);
  await db.insert(liveActivities).values({ userId: locals.user.id, apnsPushToken });
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');
  await endActiveActivities(locals.user.id);
  return json({ ok: true });
};
