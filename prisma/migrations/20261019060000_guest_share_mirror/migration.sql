-- AlterTable
ALTER TABLE "Employees" ADD COLUMN "share_mirror_employee_id" UUID;

-- CreateIndex
CREATE INDEX "Employees_share_mirror_employee_id_idx" ON "Employees"("share_mirror_employee_id");

-- AddForeignKey
ALTER TABLE "Employees" ADD CONSTRAINT "Employees_share_mirror_employee_id_fkey" FOREIGN KEY ("share_mirror_employee_id") REFERENCES "Employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
