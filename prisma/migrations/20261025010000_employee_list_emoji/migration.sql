-- List display emoji override (null = use canonical default at read time).
ALTER TABLE "EmployeeLists" ADD COLUMN IF NOT EXISTS "emoji" VARCHAR(32);
