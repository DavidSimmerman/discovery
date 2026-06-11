import type { Handle, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { readSessionCookie } from '$lib/server/session';
import { resolveDeviceToken } from '$lib/server/deviceTokens';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Drives iOS Live Activity pushes while any are registered. Dynamic import
// keeps the poller (and its Spotify/APNs imports) out of unit-test graphs.
export const init: ServerInit = async () => {
  if (building) return;
  const { startLiveActivityPoller } = await import('$lib/server/liveActivityPoller');
  startLiveActivityPoller();
};

// Auth resolution order: session cookie (web), then `Authorization: Bearer`
// device token (iOS wrapper / widget). Cookie wins when both are present.
async function resolveUserId(event: Parameters<Handle>[0]['event']): Promise<string | null> {
  const cookieUserId = readSessionCookie(event.cookies);
  if (cookieUserId) return cookieUserId;
  const auth = event.request.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return resolveDeviceToken(auth.slice('Bearer '.length));
  return null;
}

export const handle: Handle = async ({ event, resolve }) => {
  const userId = await resolveUserId(event);
  if (userId) {
    const row = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    event.locals.user = row[0]
      ? {
          id: row[0].id,
          spotifyId: row[0].spotifyId,
          displayName: row[0].displayName,
          product: row[0].product as 'premium' | 'free' | 'open',
          needsReauth: row[0].needsReauth ?? false,
        }
      : null;
  } else {
    event.locals.user = null;
  }
  return resolve(event);
};
