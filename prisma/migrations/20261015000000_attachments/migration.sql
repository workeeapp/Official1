-- AlterTable
ALTER TABLE "ChatMessages" ADD COLUMN IF NOT EXISTS "attachments" JSONB;

-- CreateTable
CREATE TABLE "Attachments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "uploader_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL DEFAULT '',
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "sha256" VARCHAR(64) NOT NULL DEFAULT '',
    "storage_key" VARCHAR(300) NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "transcript" TEXT NOT NULL DEFAULT '',
    "wa_inbound_media_id" VARCHAR(128) NOT NULL DEFAULT '',
    "wa_outbound_media_id" VARCHAR(128) NOT NULL DEFAULT '',
    "wa_outbound_uploaded_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentLinks" (
    "id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "list_id" UUID,
    "list_item_id" UUID,
    "filing_id" UUID,
    "reminder_id" UUID,
    "added_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentLinks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AttachmentLinks_one_target" CHECK (
        num_nonnulls("list_id", "list_item_id", "filing_id", "reminder_id") = 1
    )
);

-- CreateIndex
CREATE INDEX "Attachments_user_id_created_at_idx" ON "Attachments"("user_id", "created_at");
CREATE INDEX "Attachments_uploader_id_created_at_idx" ON "Attachments"("uploader_id", "created_at");
CREATE UNIQUE INDEX "AttachmentLinks_attachment_id_list_id_key" ON "AttachmentLinks"("attachment_id", "list_id");
CREATE UNIQUE INDEX "AttachmentLinks_attachment_id_list_item_id_key" ON "AttachmentLinks"("attachment_id", "list_item_id");
CREATE UNIQUE INDEX "AttachmentLinks_attachment_id_filing_id_key" ON "AttachmentLinks"("attachment_id", "filing_id");
CREATE UNIQUE INDEX "AttachmentLinks_attachment_id_reminder_id_key" ON "AttachmentLinks"("attachment_id", "reminder_id");
CREATE INDEX "AttachmentLinks_list_id_idx" ON "AttachmentLinks"("list_id");
CREATE INDEX "AttachmentLinks_list_item_id_idx" ON "AttachmentLinks"("list_item_id");
CREATE INDEX "AttachmentLinks_filing_id_idx" ON "AttachmentLinks"("filing_id");
CREATE INDEX "AttachmentLinks_reminder_id_idx" ON "AttachmentLinks"("reminder_id");

-- AddForeignKey
ALTER TABLE "Attachments" ADD CONSTRAINT "Attachments_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentLinks" ADD CONSTRAINT "AttachmentLinks_attachment_id_fkey" FOREIGN KEY ("attachment_id") REFERENCES "Attachments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentLinks" ADD CONSTRAINT "AttachmentLinks_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "EmployeeLists"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentLinks" ADD CONSTRAINT "AttachmentLinks_list_item_id_fkey" FOREIGN KEY ("list_item_id") REFERENCES "EmployeeListItems"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentLinks" ADD CONSTRAINT "AttachmentLinks_filing_id_fkey" FOREIGN KEY ("filing_id") REFERENCES "EmployeeFilings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttachmentLinks" ADD CONSTRAINT "AttachmentLinks_reminder_id_fkey" FOREIGN KEY ("reminder_id") REFERENCES "Reminders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
