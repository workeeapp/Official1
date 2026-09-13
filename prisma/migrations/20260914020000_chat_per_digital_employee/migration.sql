-- AlterTable
ALTER TABLE "ChatConversations" ADD COLUMN "digital_employee_id" UUID;

UPDATE "ChatConversations" AS c
SET "digital_employee_id" = e.id
FROM "Employees" AS e
WHERE e."user_id" = c."user_id"
  AND e."is_protected" = true
  AND c."digital_employee_id" IS NULL;

UPDATE "ChatConversations" AS c
SET "digital_employee_id" = (
  SELECT e.id
  FROM "Employees" AS e
  WHERE e."user_id" = c."user_id" AND e.kind = 'digital'
  ORDER BY e."created_at" ASC
  LIMIT 1
)
WHERE c."digital_employee_id" IS NULL;

DELETE FROM "ChatConversations" WHERE "digital_employee_id" IS NULL;

ALTER TABLE "ChatConversations" ALTER COLUMN "digital_employee_id" SET NOT NULL;

DROP INDEX "ChatConversations_user_id_employee_id_key";

CREATE UNIQUE INDEX "ChatConversations_user_id_employee_id_digital_employee_id_key"
  ON "ChatConversations"("user_id", "employee_id", "digital_employee_id");

CREATE INDEX "ChatConversations_digital_employee_id_idx"
  ON "ChatConversations"("digital_employee_id");

ALTER TABLE "ChatConversations"
  ADD CONSTRAINT "ChatConversations_digital_employee_id_fkey"
  FOREIGN KEY ("digital_employee_id") REFERENCES "Employees"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
