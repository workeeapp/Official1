-- P0 Watch→Action: deferred Action package + durable per-event execution ledger.
ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "on_trigger_actions" JSONB;
ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "on_trigger_exec" JSONB;
