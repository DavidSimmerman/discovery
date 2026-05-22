CREATE TABLE "ratings" (
	"user_id" uuid NOT NULL,
	"spotify_track_uri" text NOT NULL,
	"isrc" text,
	"rating_half_steps" smallint NOT NULL,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ratings_user_id_spotify_track_uri_pk" PRIMARY KEY("user_id","spotify_track_uri"),
	CONSTRAINT "rating_half_steps_range" CHECK ("ratings"."rating_half_steps" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"spotify_track_uri" text PRIMARY KEY NOT NULL,
	"isrc" text,
	"title" text NOT NULL,
	"artists" text[] NOT NULL,
	"album" text,
	"album_art_url" text,
	"duration_ms" integer,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;