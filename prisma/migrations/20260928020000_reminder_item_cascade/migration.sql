ALTER TABLE "EmployeeListItems" ADD COLUMN "reminder_id" UUID;

UPDATE "EmployeeListItems" AS items
SET "reminder_id" = reminders.id
FROM "Reminders" AS reminders
WHERE reminders.worker_item_id = items.id;

CREATE UNIQUE INDEX "EmployeeListItems_reminder_id_key" ON "EmployeeListItems"("reminder_id");

ALTER TABLE "EmployeeListItems"
ADD CONSTRAINT "EmployeeListItems_reminder_id_fkey"
FOREIGN KEY ("reminder_id") REFERENCES "Reminders"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Reminders" DROP CONSTRAINT "Reminders_worker_item_id_fkey";
DROP INDEX "Reminders_worker_item_id_key";
ALTER TABLE "Reminders" DROP COLUMN "worker_item_id";
