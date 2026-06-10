CREATE TABLE "playlist_track_cache" (
	"user_id" uuid NOT NULL,
	"playlist_id" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"tracks" jsonb NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_track_cache_user_id_playlist_id_pk" PRIMARY KEY("user_id","playlist_id")
);
--> statement-breakpoint
ALTER TABLE "playlist_track_cache" ADD CONSTRAINT "playlist_track_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;