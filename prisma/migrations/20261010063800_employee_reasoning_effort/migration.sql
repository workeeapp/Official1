ALTER TABLE "Employees" ADD COLUMN "reasoning_effort" VARCHAR(16);

UPDATE "Employees" SET "reasoning_effort" = 'low' WHERE "kind" = 'digital';
