import { pgTable, uuid, text, timestamp, customType } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Drizzle's pg-core doesn't ship a bytea column type; define one via customType.
const byteaCol = customType<{ data: Buffer; default: false }>({
  dataType() { return 'bytea'; },
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  spotifyId: text('spotify_id').notNull().unique(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spotifyTokens = pgTable('spotify_tokens', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenEnc: byteaCol('refresh_token_enc').notNull(),
  accessToken: text('access_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
