-- Event-relative reminder clocks (e.g. N minutes before Shabbat candle lighting).
ALTER TABLE "Reminders" ADD COLUMN "schedule_anchor" VARCHAR(32) NOT NULL DEFAULT '';
ALTER TABLE "Reminders" ADD COLUMN "schedule_offset_minutes" INTEGER NOT NULL DEFAULT 0;
