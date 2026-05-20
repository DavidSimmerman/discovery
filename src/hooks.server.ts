import type { Handle } from '@sveltejs/kit';
import { readSessionCookie } from '$lib/server/session';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const handle: Handle = async ({ event, resolve }) => {
  const userId = readSessionCookie(event.cookies);
  if (userId) {
    const row = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    event.locals.user = row[0]
      ? { id: row[0].id, spotifyId: row[0].spotifyId, displayName: row[0].displayName }
      : null;
  } else {
    event.locals.user = null;
  }
  return resolve(event);
};
