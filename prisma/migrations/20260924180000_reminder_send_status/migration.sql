ALTER TABLE "Reminders" ADD COLUMN "send_status" VARCHAR(16) NOT NULL DEFAULT 'pending';
ALTER TABLE "Reminders" ADD COLUMN "sent_at" TIMESTAMP(3);

UPDATE "Reminders"
SET "send_status" = 'sent', "sent_at" = "fire_at"
WHERE "status" = 'done';
