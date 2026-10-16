-- Phone-book row share (co-share only). Existing rows stay personal via defaults.
ALTER TABLE "Contacts"
  ADD COLUMN IF NOT EXISTS "added_by_id" UUID,
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(16) NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS "visible_to" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS "Contacts_scope_idx" ON "Contacts"("scope");
