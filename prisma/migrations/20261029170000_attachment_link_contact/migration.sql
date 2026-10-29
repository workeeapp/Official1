-- Attachments on Contacts (directory / phone book) — same AttachmentLink pattern as items/filings/reminders.
ALTER TABLE "AttachmentLinks" DROP CONSTRAINT IF EXISTS "AttachmentLinks_one_target";

ALTER TABLE "AttachmentLinks" ADD COLUMN IF NOT EXISTS "contact_id" UUID;

ALTER TABLE "AttachmentLinks"
  ADD CONSTRAINT "AttachmentLinks_one_target" CHECK (
    num_nonnulls("list_id", "list_item_id", "filing_id", "reminder_id", "contact_id") = 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS "AttachmentLinks_attachment_id_contact_id_key"
  ON "AttachmentLinks"("attachment_id", "contact_id");

CREATE INDEX IF NOT EXISTS "AttachmentLinks_contact_id_idx"
  ON "AttachmentLinks"("contact_id");

ALTER TABLE "AttachmentLinks"
  ADD CONSTRAINT "AttachmentLinks_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "Contacts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
