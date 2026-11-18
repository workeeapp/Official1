-- UWM Phase 1: per-user monitor ledger on Reminder (empty shell at capture).
ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "monitor_state" JSONB;
