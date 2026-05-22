import {
  pgTable,
  uuid,
  text,
  timestamp,
  customType,
  smallint,
  integer,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';
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

export const tracks = pgTable('tracks', {
  spotifyTrackUri: text('spotify_track_uri').primaryKey(),
  isrc: text('isrc'),
  title: text('title').notNull(),
  artists: text('artists').array().notNull(),
  album: text('album'),
  albumArtUrl: text('album_art_url'),
  durationMs: integer('duration_ms'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ratings = pgTable(
  'ratings',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    isrc: text('isrc'),
    ratingHalfSteps: smallint('rating_half_steps').notNull(),
    ratedAt: timestamp('rated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.spotifyTrackUri] }),
    check('rating_half_steps_range', sql`${table.ratingHalfSteps} between 1 and 10`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
