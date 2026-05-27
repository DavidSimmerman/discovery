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
  unique,
  index,
  boolean,
  date,
  real,
  jsonb,
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
  product: text('product').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const spotifyTokens = pgTable('spotify_tokens', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  refreshTokenEnc: byteaCol('refresh_token_enc').notNull(),
  accessToken: text('access_token'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const tracks = pgTable(
  'tracks',
  {
    spotifyTrackUri: text('spotify_track_uri').primaryKey(),
    isrc: text('isrc'),
    title: text('title').notNull(),
    artists: text('artists').array().notNull(),
    album: text('album'),
    albumArtUrl: text('album_art_url'),
    durationMs: integer('duration_ms'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
    // Shuffle-system additions (all nullable; backfilled by enrichment worker):
    releaseDate: date('release_date'),
    explicit: boolean('explicit'),
    genres: text('genres').array(),
    // Spotify artist id of the primary (first) artist — used for family grouping.
    primaryArtistId: text('primary_artist_id'),
    // Title with version markers stripped + lowercased + punctuation normalized.
    // Used to group versions of the same composition.
    canonicalTitle: text('canonical_title'),
    // Detected version: original | acoustic | live | remix | demo | instrumental
    //                 | extended | edit | cover | sped_up | slowed | re_recording | other
    versionType: text('version_type'),
    // Shared by all versions of the same composition (originals + variants).
    // Derived: hash(primary_artist_id, canonical_title).
    songFamilyId: text('song_family_id'),
    // Shared by apparent-same-recording URIs (single→album re-add, deluxe etc).
    // Confirmed by same ISRC OR (same family + duration ±1s + no version markers).
    duplicateGroupId: text('duplicate_group_id'),
  },
  (table) => [
    index('tracks_song_family_idx').on(table.songFamilyId),
    index('tracks_dup_group_idx').on(table.duplicateGroupId),
    index('tracks_primary_artist_idx').on(table.primaryArtistId),
    index('tracks_canonical_title_idx').on(table.canonicalTitle),
  ],
);

// Spotify artist cache. Genres live on the artist in Spotify's data model, not the track.
export const artists = pgTable('artists', {
  spotifyArtistId: text('spotify_artist_id').primaryKey(),
  name: text('name').notNull(),
  genres: text('genres').array().notNull().default(sql`'{}'::text[]`),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});

// Track ↔ artist join. `position` lets us preserve order ("feat." artists land after primary).
export const trackArtists = pgTable(
  'track_artists',
  {
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    spotifyArtistId: text('spotify_artist_id')
      .notNull()
      .references(() => artists.spotifyArtistId, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackUri, table.spotifyArtistId] }),
    index('track_artists_artist_idx').on(table.spotifyArtistId),
  ],
);

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
    // Used to fall back to ISRC when the same recording is encountered under a
    // different Spotify URI (Smart Shuffle / Autoplay / track relinking).
    index('ratings_user_isrc_idx').on(table.userId, table.isrc),
  ],
);

export const labels = pgTable(
  'labels',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.userId, table.name)],
);

export const trackLabels = pgTable(
  'track_labels',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    labelId: uuid('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
    appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.spotifyTrackUri, table.labelId] })],
);

// Append-only listening log. Drives cooldowns, recency curves, daily caps, exhaustion mode,
// and per-track play counts. `source` records where the pick came from (shuffle slot, manual,
// etc.); `debug` carries the sampler's per-pick score breakdown for tuning.
export const plays = pgTable(
  'plays',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).defaultNow().notNull(),
    // 'shuffle' | 'manual' | 'queue' | 'autoplay' | 'ai_suggestion' | etc.
    source: text('source').notNull().default('shuffle'),
    skipped: boolean('skipped').notNull().default(false),
    msPlayed: integer('ms_played'),
    // Sampler diagnostics: scores, applied relaxations, slot index, drift state, etc.
    debug: jsonb('debug'),
  },
  (table) => [
    index('plays_user_played_at_idx').on(table.userId, table.playedAt.desc()),
    index('plays_user_track_played_at_idx').on(
      table.userId,
      table.spotifyTrackUri,
      table.playedAt.desc(),
    ),
  ],
);

// ReccoBeats audio-features cache. One row per Spotify URI. Raw values from the provider;
// normalization (tempo→[0,1], loudness→[0,1]) happens at read time in the sampler.
export const trackFeatures = pgTable('track_features', {
  spotifyTrackUri: text('spotify_track_uri').primaryKey(),
  energy: real('energy'),
  valence: real('valence'),
  danceability: real('danceability'),
  acousticness: real('acousticness'),
  instrumentalness: real('instrumentalness'),
  liveness: real('liveness'),
  speechiness: real('speechiness'),
  tempo: real('tempo'),         // BPM
  loudness: real('loudness'),   // dB
  // 'reccobeats' for now; opens door to fallback providers (freqblog, last.fm tags, etc.).
  provider: text('provider').notNull().default('reccobeats'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});

// Last.fm `track.getSimilar` cache. (uri, similar_uri) per row with match score.
// Drives Suggested Discovery's candidate pool.
export const trackSimilars = pgTable(
  'track_similars',
  {
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    similarUri: text('similar_uri').notNull(),
    matchScore: real('match_score'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackUri, table.similarUri] }),
    index('track_similars_similar_idx').on(table.similarUri),
  ],
);

// MusicBrainz work/recording metadata cache. Drives cover/version detection.
// `workAttributes` carries MB relationship attributes: 'cover', 'live', 'acoustic', etc.
export const trackWorks = pgTable('track_works', {
  spotifyTrackUri: text('spotify_track_uri').primaryKey(),
  recordingMbid: text('recording_mbid'),
  workMbid: text('work_mbid'),
  workAttributes: text('work_attributes').array().notNull().default(sql`'{}'::text[]`),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
});

// Saved shuffle configurations. Each user can have many named presets plus the
// engine's built-in starter presets (those live in code, not here).
// `config` is the full filter/weight/rotation/slot tree as JSON — schema versioned
// inside the blob via a `version` key so we can migrate config shapes without DDL.
export const shufflePresets = pgTable(
  'shuffle_presets',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    config: jsonb('config').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.userId, table.name)],
);

// One active shuffle session per user. Holds the live engine state (slot cursor,
// recents ring, drift centroid, dup-rotation cursors, etc.) so picks survive restarts.
// `activeConfig` is the resolved config at session start; `state` is the mutable sampler state.
export const shuffleSessions = pgTable('shuffle_sessions', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  presetId: uuid('preset_id').references(() => shufflePresets.id, { onDelete: 'set null' }),
  activeConfig: jsonb('active_config').notNull(),
  state: jsonb('state').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Per-track credits (songwriters, producers, engineers, etc.) sourced from MusicBrainz
// (and Genius as fallback for chart pop). Spotify's Web API doesn't expose this.
// The reverse index (person_mbid, role) is the load-bearing query:
// "find every track Jon Bellion co-wrote" → recommend his solo catalog.
export const trackCredits = pgTable(
  'track_credits',
  {
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    personMbid: text('person_mbid').notNull(),
    personName: text('person_name').notNull(),
    // composer | lyricist | producer | engineer | mixer | featured | arranger | instrument | other
    role: text('role').notNull(),
    // 'musicbrainz' | 'genius' — lets us prefer the more authoritative source on conflict.
    provider: text('provider').notNull().default('musicbrainz'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.spotifyTrackUri, table.personMbid, table.role] }),
    // "Every track this person is credited on, by role" — drives the credits-graph
    // discovery source and the credits-filter card.
    index('track_credits_person_role_idx').on(table.personMbid, table.role),
  ],
);

// LLM-generated discovery suggestions. Written by the nightly Claude routine,
// consumed by the sampler's `source: 'ai'` pool. `consumedAt` flips when first played.
export const aiSuggestions = pgTable(
  'ai_suggestions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    spotifyTrackUri: text('spotify_track_uri').notNull(),
    // 'nightly_review' | 'weekly_recap' | 'natural_language_playlist' | etc.
    source: text('source').notNull(),
    confidence: real('confidence'),
    reasoning: text('reasoning'),
    candidatePoolRank: integer('candidate_pool_rank'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    // Hot path: "give me this user's unconsumed suggestions."
    index('ai_suggestions_user_unconsumed_idx').on(table.userId, table.consumedAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
