-- AlterTable
ALTER TABLE "EmployeeListItems" ADD COLUMN "scope" VARCHAR(16) NOT NULL DEFAULT 'personal';
ALTER TABLE "EmployeeListItems" ADD COLUMN "added_by_id" UUID;
ALTER TABLE "EmployeeListItems" ADD COLUMN "visible_to" JSONB NOT NULL DEFAULT '[]';

-- CreateIndex
CREATE INDEX "EmployeeListItems_scope_idx" ON "EmployeeListItems"("scope");
