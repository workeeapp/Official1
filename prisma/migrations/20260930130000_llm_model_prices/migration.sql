-- Per-model token prices (USD per 1M tokens, standard tier) and per-call cost.

CREATE TABLE IF NOT EXISTS "LlmModelPrices" (
  "id" UUID NOT NULL,
  "model" VARCHAR(100) NOT NULL,
  "input_usd_per_1m" DECIMAL(12,6) NOT NULL,
  "cached_input_usd_per_1m" DECIMAL(12,6) NOT NULL,
  "cache_write_usd_per_1m" DECIMAL(12,6),
  "output_usd_per_1m" DECIMAL(12,6) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmModelPrices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LlmModelPrices_model_key" ON "LlmModelPrices" ("model");

ALTER TABLE "LlmUsages" ADD COLUMN IF NOT EXISTS "cost_usd" DECIMAL(14,8);
ALTER TABLE "LlmUsages" ADD COLUMN IF NOT EXISTS "price_model" VARCHAR(100);

-- OpenAI pricing as of 2026-09-30.
INSERT INTO "LlmModelPrices"
  ("id", "model", "input_usd_per_1m", "cached_input_usd_per_1m", "cache_write_usd_per_1m", "output_usd_per_1m")
VALUES
  (gen_random_uuid(), 'gpt-6-astra',   10.00, 1.00,  12.50,  50.00),
  (gen_random_uuid(), 'gpt-6.1-sol',    2.00, 0.10,   2.50,  10.00),
  (gen_random_uuid(), 'gpt-6-luna',     0.10, 0.01,   0.125,  0.50),
  (gen_random_uuid(), 'gpt-5.6-sol',    4.00, 0.40,   5.00,  20.00),
  (gen_random_uuid(), 'gpt-5.6-terra',  2.00, 0.20,   2.50,  12.00),
  (gen_random_uuid(), 'gpt-4.1',        2.00, 0.50,   NULL,   8.00),
  (gen_random_uuid(), 'gpt-4.1-mini',   0.40, 0.10,   NULL,   1.60)
ON CONFLICT ("model") DO NOTHING;

-- Backfill cost for usage recorded before prices existed. Snapshot model names
-- like gpt-4.1-mini-2025-04-14 match their base model.
UPDATE "LlmUsages" u
SET
  "price_model" = p."model",
  "cost_usd" = (
    GREATEST(u."input_tokens" - u."cached_tokens", 0) * p."input_usd_per_1m"
    + u."cached_tokens" * p."cached_input_usd_per_1m"
    + u."output_tokens" * p."output_usd_per_1m"
  ) / 1000000
FROM "LlmModelPrices" p
WHERE u."cost_usd" IS NULL
  AND p."model" = regexp_replace(u."model", '-\d{4}-\d{2}-\d{2}$', '');
