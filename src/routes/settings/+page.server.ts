import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { spotifyTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Surfaces the GRANTED scopes (stored from Spotify's token responses) so the
// settings page can show whether Liked-Songs sync is actually authorized —
// the request list and the consent screen can both mislead.
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { grantedScopes: null };
  const row = await db
    .select({ scope: spotifyTokens.scope })
    .from(spotifyTokens)
    .where(eq(spotifyTokens.userId, locals.user.id))
    .limit(1);
  return { grantedScopes: row[0]?.scope ?? null };
};
