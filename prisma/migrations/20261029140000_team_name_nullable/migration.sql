-- WhatsApp-only accounts have no username; Team.name mirrors that (nullable).
ALTER TABLE "Teams" ALTER COLUMN "name" DROP NOT NULL;
