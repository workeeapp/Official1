-- AlterTable
ALTER TABLE "EmployeeListItems" ADD COLUMN IF NOT EXISTS "linked_reminder_id" UUID;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmployeeListItems_linked_reminder_id_idx" ON "EmployeeListItems"("linked_reminder_id");

-- AddForeignKey
ALTER TABLE "EmployeeListItems" ADD CONSTRAINT "EmployeeListItems_linked_reminder_id_fkey" FOREIGN KEY ("linked_reminder_id") REFERENCES "Reminders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
