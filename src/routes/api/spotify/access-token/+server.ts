import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getValidAccessToken } from '$lib/server/tokens';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'not logged in');

  const access_token = await getValidAccessToken(locals.user.id);

  const row = await db.select().from(spotifyTokens)
    .where(eq(spotifyTokens.userId, locals.user.id)).limit(1);
  const expires_at = row[0]?.expiresAt?.getTime() ?? 0;

  return json({ access_token, expires_at });
};
