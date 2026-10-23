-- Mark compose/chat LLM rows for accounting analytics.
ALTER TABLE "LlmUsages" ADD COLUMN "purpose" VARCHAR(32) NOT NULL DEFAULT 'chat';
CREATE INDEX "LlmUsages_purpose_created_at_idx" ON "LlmUsages"("purpose", "created_at");
