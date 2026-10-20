-- Conditional watch clocks: structured condition evaluated at fire time.
ALTER TABLE "Reminders" ADD COLUMN "compose_condition" JSONB;
