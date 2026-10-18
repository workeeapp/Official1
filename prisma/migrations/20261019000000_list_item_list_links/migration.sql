-- CreateTable
CREATE TABLE IF NOT EXISTS "ListItemListLinks" (
    "id" UUID NOT NULL,
    "list_item_id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "added_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListItemListLinks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ListItemListLinks_list_item_id_list_id_key" ON "ListItemListLinks"("list_item_id", "list_id");
CREATE INDEX IF NOT EXISTS "ListItemListLinks_list_item_id_idx" ON "ListItemListLinks"("list_item_id");
CREATE INDEX IF NOT EXISTS "ListItemListLinks_list_id_idx" ON "ListItemListLinks"("list_id");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "ListItemListLinks" ADD CONSTRAINT "ListItemListLinks_list_item_id_fkey" FOREIGN KEY ("list_item_id") REFERENCES "EmployeeListItems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "ListItemListLinks" ADD CONSTRAINT "ListItemListLinks_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "EmployeeLists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
