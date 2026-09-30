-- Per-call LLM token usage, kept per conversation even when chat messages rotate.

CREATE TABLE IF NOT EXISTS "LlmUsages" (
  "id" UUID NOT NULL,
  "conversation_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL,
  "digital_employee_id" UUID NOT NULL,
  "openai_conversation_id" VARCHAR(255) NOT NULL,
  "response_id" VARCHAR(255),
  "model" VARCHAR(100) NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_tokens" INTEGER NOT NULL DEFAULT 0,
  "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_tokens" INTEGER NOT NULL DEFAULT 0,
  "usage" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmUsages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LlmUsages_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "ChatConversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "LlmUsages_conversation_id_created_at_idx"
  ON "LlmUsages" ("conversation_id", "created_at");

CREATE INDEX IF NOT EXISTS "LlmUsages_employee_id_created_at_idx"
  ON "LlmUsages" ("employee_id", "created_at");

CREATE INDEX IF NOT EXISTS "LlmUsages_digital_employee_id_created_at_idx"
  ON "LlmUsages" ("digital_employee_id", "created_at");
