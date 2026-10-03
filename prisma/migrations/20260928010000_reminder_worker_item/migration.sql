ALTER TABLE "Reminders" ADD COLUMN "worker_item_id" UUID;
CREATE UNIQUE INDEX "Reminders_worker_item_id_key" ON "Reminders"("worker_item_id");
ALTER TABLE "Reminders" ADD CONSTRAINT "Reminders_worker_item_id_fkey" FOREIGN KEY ("worker_item_id") REFERENCES "EmployeeListItems"("id") ON DELETE SET NULL ON UPDATE CASCADE;
