-- AlterTable
ALTER TABLE "Employees" ADD COLUMN "profile_attachment_id" UUID;

-- CreateIndex
CREATE INDEX "Employees_profile_attachment_id_idx" ON "Employees"("profile_attachment_id");

-- AddForeignKey
ALTER TABLE "Employees" ADD CONSTRAINT "Employees_profile_attachment_id_fkey" FOREIGN KEY ("profile_attachment_id") REFERENCES "Attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
