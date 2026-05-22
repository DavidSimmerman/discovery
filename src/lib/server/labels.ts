import { db } from '$lib/server/db';
import { labels, trackLabels } from '$lib/server/db/schema';
import { and, eq, desc, asc } from 'drizzle-orm';

export async function listLabels(
  userId: string,
): Promise<{ id: string; name: string; lastUsedAt: Date }[]> {
  return db
    .select({ id: labels.id, name: labels.name, lastUsedAt: labels.lastUsedAt })
    .from(labels)
    .where(eq(labels.userId, userId))
    .orderBy(desc(labels.lastUsedAt), asc(labels.name));
}

export async function appliedLabelIds(userId: string, trackUri: string): Promise<string[]> {
  const rows = await db
    .select({ labelId: trackLabels.labelId })
    .from(trackLabels)
    .where(and(eq(trackLabels.userId, userId), eq(trackLabels.spotifyTrackUri, trackUri)));
  return rows.map((r) => r.labelId);
}

export async function applyLabel(
  userId: string,
  trackUri: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();

  const [label] = await db
    .insert(labels)
    .values({ userId, name: trimmed, lastUsedAt: new Date() })
    .onConflictDoUpdate({
      target: [labels.userId, labels.name],
      set: { lastUsedAt: new Date() },
    })
    .returning({ id: labels.id, name: labels.name });

  await db
    .insert(trackLabels)
    .values({ userId, spotifyTrackUri: trackUri, labelId: label.id })
    .onConflictDoNothing();

  return label;
}

export async function unapplyLabel(
  userId: string,
  trackUri: string,
  labelId: string,
): Promise<void> {
  await db
    .delete(trackLabels)
    .where(
      and(
        eq(trackLabels.userId, userId),
        eq(trackLabels.spotifyTrackUri, trackUri),
        eq(trackLabels.labelId, labelId),
      ),
    );
}
