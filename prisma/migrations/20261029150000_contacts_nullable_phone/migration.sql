-- Phoneless contacts: phone nullable; extras + migrated_from_item_id for unify.
-- Optional description (תיאור) note on contacts.
-- Existing UNIQUE(owner_employee_id, phone) already allows multiple NULL phones
-- in PostgreSQL — no partial-index rewrite needed.

ALTER TABLE "Contacts" ALTER COLUMN "phone" DROP NOT NULL;

ALTER TABLE "Contacts" ADD COLUMN IF NOT EXISTS "description" VARCHAR(500);
ALTER TABLE "Contacts" ADD COLUMN IF NOT EXISTS "extras" JSONB;
ALTER TABLE "Contacts" ADD COLUMN IF NOT EXISTS "migrated_from_item_id" UUID;

CREATE INDEX IF NOT EXISTS "Contacts_migrated_from_item_id_idx"
  ON "Contacts"("migrated_from_item_id");
