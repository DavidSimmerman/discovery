CREATE TABLE "user_top_artists" (
	"user_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_top_artists_user_id_rank_pk" PRIMARY KEY("user_id","rank")
);
--> statement-breakpoint
CREATE TABLE "user_top_tracks" (
	"user_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"spotify_track_uri" text NOT NULL,
	"name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_top_tracks_user_id_rank_pk" PRIMARY KEY("user_id","rank")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "top_lists_refreshed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_top_artists" ADD CONSTRAINT "user_top_artists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_top_tracks" ADD CONSTRAINT "user_top_tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;