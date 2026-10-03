-- AlterTable
ALTER TABLE "WhatsAppInbounds" ADD COLUMN "active_digital_employee_id" UUID;

-- CreateIndex
CREATE INDEX "WhatsAppInbounds_active_digital_employee_id_idx" ON "WhatsAppInbounds"("active_digital_employee_id");

-- AddForeignKey
ALTER TABLE "WhatsAppInbounds" ADD CONSTRAINT "WhatsAppInbounds_active_digital_employee_id_fkey" FOREIGN KEY ("active_digital_employee_id") REFERENCES "Employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "WhatsAppProcessedMessages" (
    "message_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppProcessedMessages_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "WhatsAppProcessedMessages_created_at_idx" ON "WhatsAppProcessedMessages"("created_at");
