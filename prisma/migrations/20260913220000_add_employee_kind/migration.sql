-- AlterTable
ALTER TABLE "Employees" ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'human';
ALTER TABLE "Employees" ADD COLUMN "model" VARCHAR(100);
ALTER TABLE "Employees" ADD COLUMN "temperature" DOUBLE PRECISION;
ALTER TABLE "Employees" ADD COLUMN "instructions" TEXT;
