-- Item identity is EmployeeListItems.id. item_key is a derived label only —
-- multiple live rows on the same list may share the same key.
DROP INDEX IF EXISTS "EmployeeListItems_list_id_item_key_active_key";

CREATE INDEX IF NOT EXISTS "EmployeeListItems_list_id_item_key_idx"
  ON "EmployeeListItems" ("list_id", "item_key");
