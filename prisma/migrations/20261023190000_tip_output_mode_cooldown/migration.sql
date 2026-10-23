-- Tip output mode (static | dynamic) and cooldown between shows.
ALTER TABLE "Tips" ADD COLUMN "output_mode" VARCHAR(16) NOT NULL DEFAULT 'static';
ALTER TABLE "Tips" ADD COLUMN "min_interval_minutes" INTEGER NOT NULL DEFAULT 0;
