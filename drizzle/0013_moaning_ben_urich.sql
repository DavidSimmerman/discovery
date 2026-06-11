CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "device_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "live_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"apns_push_token" text NOT NULL,
	"device_token_id" uuid,
	"content_state_hash" text,
	"last_track_uri" text,
	"stopped_since" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_device_token_id_device_tokens_id_fk" FOREIGN KEY ("device_token_id") REFERENCES "public"."device_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_active_user_idx" ON "live_activities" USING btree ("user_id") WHERE "live_activities"."ended_at" is null;