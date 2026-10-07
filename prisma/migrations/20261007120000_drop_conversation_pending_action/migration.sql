-- Multi-turn drafts live in the model's conversation now; the server keeps no Action State.
ALTER TABLE "ChatConversations"
    DROP COLUMN IF EXISTS "pending_action",
    DROP COLUMN IF EXISTS "pending_targets",
    DROP COLUMN IF EXISTS "pending_step",
    DROP COLUMN IF EXISTS "pending_at";
