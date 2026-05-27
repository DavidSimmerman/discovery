CREATE TABLE "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"spotify_track_uri" text NOT NULL,
	"source" text NOT NULL,
	"confidence" real,
	"reasoning" text,
	"candidate_pool_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "artists" (
	"spotify_artist_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"spotify_track_uri" text NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'shuffle' NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"ms_played" integer,
	"debug" jsonb
);
--> statement-breakpoint
CREATE TABLE "shuffle_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_presets_user_id_name_unique" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "shuffle_sessions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"preset_id" uuid,
	"active_config" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_artists" (
	"spotify_track_uri" text NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "track_artists_spotify_track_uri_spotify_artist_id_pk" PRIMARY KEY("spotify_track_uri","spotify_artist_id")
);
--> statement-breakpoint
CREATE TABLE "track_credits" (
	"spotify_track_uri" text NOT NULL,
	"person_mbid" text NOT NULL,
	"person_name" text NOT NULL,
	"role" text NOT NULL,
	"provider" text DEFAULT 'musicbrainz' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_credits_spotify_track_uri_person_mbid_role_pk" PRIMARY KEY("spotify_track_uri","person_mbid","role")
);
--> statement-breakpoint
CREATE TABLE "track_features" (
	"spotify_track_uri" text PRIMARY KEY NOT NULL,
	"energy" real,
	"valence" real,
	"danceability" real,
	"acousticness" real,
	"instrumentalness" real,
	"liveness" real,
	"speechiness" real,
	"tempo" real,
	"loudness" real,
	"provider" text DEFAULT 'reccobeats' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_similars" (
	"spotify_track_uri" text NOT NULL,
	"similar_uri" text NOT NULL,
	"match_score" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "track_similars_spotify_track_uri_similar_uri_pk" PRIMARY KEY("spotify_track_uri","similar_uri")
);
--> statement-breakpoint
CREATE TABLE "track_works" (
	"spotify_track_uri" text PRIMARY KEY NOT NULL,
	"recording_mbid" text,
	"work_mbid" text,
	"work_attributes" text[] DEFAULT '{}'::text[] NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "release_date" date;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "explicit" boolean;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "genres" text[];--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "primary_artist_id" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "canonical_title" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "version_type" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "song_family_id" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "duplicate_group_id" text;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_presets" ADD CONSTRAINT "shuffle_presets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_sessions" ADD CONSTRAINT "shuffle_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_sessions" ADD CONSTRAINT "shuffle_sessions_preset_id_shuffle_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."shuffle_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_artists" ADD CONSTRAINT "track_artists_spotify_artist_id_artists_spotify_artist_id_fk" FOREIGN KEY ("spotify_artist_id") REFERENCES "public"."artists"("spotify_artist_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_suggestions_user_unconsumed_idx" ON "ai_suggestions" USING btree ("user_id","consumed_at");--> statement-breakpoint
CREATE INDEX "plays_user_played_at_idx" ON "plays" USING btree ("user_id","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "plays_user_track_played_at_idx" ON "plays" USING btree ("user_id","spotify_track_uri","played_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "track_artists_artist_idx" ON "track_artists" USING btree ("spotify_artist_id");--> statement-breakpoint
CREATE INDEX "track_credits_person_role_idx" ON "track_credits" USING btree ("person_mbid","role");--> statement-breakpoint
CREATE INDEX "track_similars_similar_idx" ON "track_similars" USING btree ("similar_uri");--> statement-breakpoint
CREATE INDEX "tracks_song_family_idx" ON "tracks" USING btree ("song_family_id");--> statement-breakpoint
CREATE INDEX "tracks_dup_group_idx" ON "tracks" USING btree ("duplicate_group_id");--> statement-breakpoint
CREATE INDEX "tracks_primary_artist_idx" ON "tracks" USING btree ("primary_artist_id");--> statement-breakpoint
CREATE INDEX "tracks_canonical_title_idx" ON "tracks" USING btree ("canonical_title");