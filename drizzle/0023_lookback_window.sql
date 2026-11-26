ALTER TABLE "settings" ADD COLUMN "default_window_preset" text DEFAULT '3y' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "default_history_policy" text DEFAULT 'common' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "min_obs_per_asset" double precision DEFAULT 10 NOT NULL;