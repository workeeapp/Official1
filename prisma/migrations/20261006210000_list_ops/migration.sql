-- List-level ops (alter_list / delete_list): declared + hidden columns and
-- soft delete. Name uniqueness becomes partial so a deleted list's name can be reused.

ALTER TABLE "EmployeeLists"
  ADD COLUMN IF NOT EXISTS "columns" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "hidden_columns" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

ALTER TABLE "EmployeeLists" DROP CONSTRAINT IF EXISTS "EmployeeLists_employee_id_list_type_name_key";
DROP INDEX IF EXISTS "EmployeeLists_employee_id_list_type_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeLists_employee_id_list_type_name_active_key"
  ON "EmployeeLists" ("employee_id", "list_type", "name")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "EmployeeLists_employee_id_list_type_name_idx"
  ON "EmployeeLists" ("employee_id", "list_type", "name");

CREATE INDEX IF NOT EXISTS "EmployeeLists_deleted_at_idx" ON "EmployeeLists" ("deleted_at");
