-- Collapse half-star ratings into whole stars. Going forward, ratings are
-- stored as 1..5 whole stars in `rating_stars`; the half-step column is gone.
--
-- Mapping (floor toward 0):
--   1 half-step (0.5★) → no rating (row deleted, since 0 is "unrated")
--   2,3            → 1★
--   4,5            → 2★
--   6,7            → 3★
--   8,9            → 4★
--   10             → 5★

DELETE FROM ratings WHERE rating_half_steps = 1;
--> statement-breakpoint
UPDATE ratings SET rating_half_steps = rating_half_steps / 2;
--> statement-breakpoint
ALTER TABLE ratings DROP CONSTRAINT "rating_half_steps_range";
--> statement-breakpoint
ALTER TABLE ratings RENAME COLUMN "rating_half_steps" TO "rating_stars";
--> statement-breakpoint
ALTER TABLE ratings ADD CONSTRAINT "rating_stars_range" CHECK ("ratings"."rating_stars" between 1 and 5);
