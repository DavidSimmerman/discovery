import { createHash, randomBytes } from 'node:crypto';
import { db } from '$lib/server/db';
import { deviceTokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

// Opaque bearer tokens for the iOS wrapper. Plaintext is returned once at mint
// time; only the SHA-256 hex is stored, so a DB leak doesn't leak live tokens.

const TOKEN_BYTES = 32; // → 43-char base64url
const MIN_TOKEN_LENGTH = 43;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function mintDeviceToken(userId: string, label?: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  await db.insert(deviceTokens).values({ userId, label: label ?? null, tokenHash: hashToken(token) });
  return token;
}

export async function resolveDeviceToken(token: string): Promise<string | null> {
  if (token.length < MIN_TOKEN_LENGTH) return null;
  const rows = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0] as { id: string; userId: string } | undefined;
  if (!row) return null;
  // Fire-and-forget freshness marker; never block or fail auth on it.
  void db
    .update(deviceTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(deviceTokens.id, row.id))
    .catch(() => {});
  return row.userId;
}
