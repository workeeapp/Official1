-- Stage 6: Reminder high-risk auth marker + DeliveryAttempt.ledger_key unique

ALTER TABLE "Reminders" ADD COLUMN "high_risk_authorized_at" TIMESTAMP(3);

ALTER TABLE "DeliveryAttempts" ADD COLUMN "ledger_key" VARCHAR(255);

UPDATE "DeliveryAttempts"
SET "ledger_key" = CASE
  WHEN "confirm_id" IS NOT NULL THEN "confirm_id"::text || ':' || "step_key"
  ELSE "id"::text
END
WHERE "ledger_key" IS NULL;

ALTER TABLE "DeliveryAttempts" ALTER COLUMN "ledger_key" SET NOT NULL;

DROP INDEX IF EXISTS "DeliveryAttempts_confirm_id_step_key_key";

CREATE UNIQUE INDEX "DeliveryAttempts_ledger_key_key" ON "DeliveryAttempts"("ledger_key");
