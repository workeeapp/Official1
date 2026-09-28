-- Durable Action State for reminder delete confirmation (per conversation).
ALTER TABLE "ChatConversations"
ADD COLUMN IF NOT EXISTS "pending_action" VARCHAR(32),
ADD COLUMN IF NOT EXISTS "pending_targets" JSONB,
ADD COLUMN IF NOT EXISTS "pending_step" VARCHAR(32),
ADD COLUMN IF NOT EXISTS "pending_at" TIMESTAMP(3);
