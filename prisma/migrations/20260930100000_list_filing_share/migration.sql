-- List-level and filing-level sharing (partners see all items; guests view-only).
ALTER TABLE "EmployeeLists"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(16) NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS "visible_to" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "EmployeeFilings"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(16) NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS "visible_to" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS "EmployeeLists_scope_idx" ON "EmployeeLists"("scope");
CREATE INDEX IF NOT EXISTS "EmployeeFilings_scope_idx" ON "EmployeeFilings"("scope");
