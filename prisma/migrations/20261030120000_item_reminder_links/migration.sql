-- Multi-clock item↔reminder links (join table).
-- Preflight: abort when the same linked_reminder_id appears on more than one live item.
DO $$
DECLARE
  conflict_count int;
  conflict_ids text;
BEGIN
  SELECT COUNT(*)::int, COALESCE(string_agg(linked_reminder_id::text, ', '), '')
  INTO conflict_count, conflict_ids
  FROM (
    SELECT linked_reminder_id
    FROM "EmployeeListItems"
    WHERE linked_reminder_id IS NOT NULL
      AND deleted_at IS NULL
    GROUP BY linked_reminder_id
    HAVING COUNT(*) > 1
  ) conflicts;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'EmployeeListItemReminderLinks preflight abort: % linked_reminder_id value(s) appear on multiple live items: %',
      conflict_count,
      conflict_ids;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "EmployeeListItemReminderLinks" (
    "id" UUID NOT NULL,
    "list_item_id" UUID NOT NULL,
    "reminder_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeListItemReminderLinks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeListItemReminderLinks_list_item_id_reminder_id_key"
  ON "EmployeeListItemReminderLinks"("list_item_id", "reminder_id");
CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeListItemReminderLinks_reminder_id_key"
  ON "EmployeeListItemReminderLinks"("reminder_id");
CREATE INDEX IF NOT EXISTS "EmployeeListItemReminderLinks_list_item_id_idx"
  ON "EmployeeListItemReminderLinks"("list_item_id");

DO $$ BEGIN
  ALTER TABLE "EmployeeListItemReminderLinks"
    ADD CONSTRAINT "EmployeeListItemReminderLinks_list_item_id_fkey"
    FOREIGN KEY ("list_item_id") REFERENCES "EmployeeListItems"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "EmployeeListItemReminderLinks"
    ADD CONSTRAINT "EmployeeListItemReminderLinks_reminder_id_fkey"
    FOREIGN KEY ("reminder_id") REFERENCES "Reminders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from legacy soft-link FK (live items only). Unique(reminder_id) + preflight
-- guarantee at most one row per reminder; skipDuplicates for idempotent re-run.
INSERT INTO "EmployeeListItemReminderLinks" (id, list_item_id, reminder_id, created_at)
SELECT gen_random_uuid(), id, linked_reminder_id, NOW()
FROM "EmployeeListItems"
WHERE linked_reminder_id IS NOT NULL
  AND deleted_at IS NULL
ON CONFLICT DO NOTHING;
