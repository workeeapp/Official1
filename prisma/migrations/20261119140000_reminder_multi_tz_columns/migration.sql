-- Stage 1 (multi-TZ reminders): additive columns only.
-- No UPDATE of fire_at / recurrence. Existing Reminders keep NULL schedule fields.
-- Employees.time_zone defaults to Asia/Jerusalem for new and existing rows.

ALTER TABLE "Employees" ADD COLUMN IF NOT EXISTS "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Jerusalem';

ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "schedule_time_zone" VARCHAR(64);
ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "wall_clock_intent" VARCHAR(16);
