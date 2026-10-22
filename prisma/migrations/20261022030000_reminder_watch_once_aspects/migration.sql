-- AlterTable
ALTER TABLE "Reminders" ADD COLUMN "watch_once" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Reminders" ADD COLUMN "compose_aspects" JSONB;
