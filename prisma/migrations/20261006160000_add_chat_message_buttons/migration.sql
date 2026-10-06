-- AlterTable
ALTER TABLE "ChatMessages" ADD COLUMN IF NOT EXISTS "buttons" JSONB;
