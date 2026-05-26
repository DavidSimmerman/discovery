CREATE INDEX "ratings_user_isrc_idx" ON "ratings" USING btree ("user_id","isrc");
--> statement-breakpoint
-- Backfill: merge duplicate-ISRC ratings (same recording under different URIs).
-- Keep the most recent rated_at per (user_id, isrc); break ties by URI for determinism.
WITH ranked AS (
  SELECT ctid,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, isrc
           ORDER BY rated_at DESC, spotify_track_uri ASC
         ) AS rn
  FROM ratings
  WHERE isrc IS NOT NULL
)
DELETE FROM ratings
WHERE ctid IN (SELECT ctid FROM ranked WHERE rn > 1);
