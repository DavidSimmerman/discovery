CREATE TABLE "artist_top_tracks" (
	"artist_key" text NOT NULL,
	"rank" smallint NOT NULL,
	"lastfm_title" text NOT NULL,
	"spotify_track_uri" text,
	"isrc" text,
	"album" text,
	"album_art_url" text,
	"playcount" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artist_top_tracks_artist_key_rank_pk" PRIMARY KEY("artist_key","rank")
);
