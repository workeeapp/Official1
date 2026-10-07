-- AlterTable
ALTER TABLE "EmployeeListItems" ADD COLUMN IF NOT EXISTS "urgency" VARCHAR(16) NOT NULL DEFAULT 'normal';
