-- AlterTable
ALTER TABLE "Reminders" ADD COLUMN IF NOT EXISTS "compose_lookback_hours" DOUBLE PRECISION NOT NULL DEFAULT 0;
-- If an earlier INTEGER column exists, widen it:
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Reminders'
      AND column_name = 'compose_lookback_hours'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE "Reminders"
      ALTER COLUMN "compose_lookback_hours" TYPE DOUBLE PRECISION
      USING "compose_lookback_hours"::double precision;
  END IF;
END $$;
