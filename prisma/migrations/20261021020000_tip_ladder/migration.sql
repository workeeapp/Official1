-- Tip ladder: tier / topic / list_type / unlock + system seed flag
ALTER TABLE "Tips" ADD COLUMN IF NOT EXISTS "tier" VARCHAR(16) NOT NULL DEFAULT 'basic';
ALTER TABLE "Tips" ADD COLUMN IF NOT EXISTS "topic" VARCHAR(32);
ALTER TABLE "Tips" ADD COLUMN IF NOT EXISTS "list_type" VARCHAR(32);
ALTER TABLE "Tips" ADD COLUMN IF NOT EXISTS "unlock_after_key" VARCHAR(64);
ALTER TABLE "Tips" ADD COLUMN IF NOT EXISTS "system_seed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Tips_user_id_topic_tier_idx" ON "Tips" ("user_id", "topic", "tier");
