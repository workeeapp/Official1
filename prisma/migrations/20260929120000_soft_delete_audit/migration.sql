-- Soft-delete columns + audit log. Replace hard unique constraints with
-- partial uniques so a deleted row does not block re-adding the same key.

ALTER TABLE "EmployeeListItems" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

ALTER TABLE "EmployeeFilings" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

ALTER TABLE "EmployeeListItems" DROP CONSTRAINT IF EXISTS "EmployeeListItems_list_id_item_key_key";
DROP INDEX IF EXISTS "EmployeeListItems_list_id_item_key_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeListItems_list_id_item_key_active_key"
  ON "EmployeeListItems" ("list_id", "item_key")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "EmployeeFilings" DROP CONSTRAINT IF EXISTS "EmployeeFilings_employee_id_item_name_key";
DROP INDEX IF EXISTS "EmployeeFilings_employee_id_item_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeFilings_employee_id_item_name_active_key"
  ON "EmployeeFilings" ("employee_id", "item_name")
  WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "AuditEvents" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "actor_employee_id" UUID,
  "action" VARCHAR(64) NOT NULL,
  "entity_type" VARCHAR(64) NOT NULL,
  "entity_id" UUID,
  "summary" VARCHAR(500) NOT NULL,
  "detail" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AuditEvents_user_id_created_at_idx"
  ON "AuditEvents" ("user_id", "created_at");

CREATE INDEX IF NOT EXISTS "AuditEvents_entity_type_entity_id_idx"
  ON "AuditEvents" ("entity_type", "entity_id");
