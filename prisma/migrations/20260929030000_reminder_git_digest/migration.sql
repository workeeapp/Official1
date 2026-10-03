-- AlterTable
ALTER TABLE "Reminders" ADD COLUMN "compose_source" VARCHAR(32) NOT NULL DEFAULT '';
ALTER TABLE "Reminders" ADD COLUMN "last_report_sha" VARCHAR(64) NOT NULL DEFAULT '';
