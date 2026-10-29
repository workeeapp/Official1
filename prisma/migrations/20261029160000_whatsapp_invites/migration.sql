-- AlterTable
ALTER TABLE "ChatMessages" ADD COLUMN IF NOT EXISTS "whatsapp_compose_url" VARCHAR(2000);

-- CreateTable
CREATE TABLE IF NOT EXISTS "WhatsAppInvites" (
    "id" UUID NOT NULL,
    "token" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "asker_employee_id" UUID NOT NULL,
    "digital_employee_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "recipient_label" VARCHAR(100) NOT NULL,
    "ask_summary" VARCHAR(500) NOT NULL,
    "draft_text" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "guest_employee_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "WhatsAppInvites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppInvites_token_key" ON "WhatsAppInvites"("token");
CREATE INDEX IF NOT EXISTS "WhatsAppInvites_user_id_status_idx" ON "WhatsAppInvites"("user_id", "status");
CREATE INDEX IF NOT EXISTS "WhatsAppInvites_recipient_phone_status_idx" ON "WhatsAppInvites"("recipient_phone", "status");
CREATE INDEX IF NOT EXISTS "WhatsAppInvites_guest_employee_id_idx" ON "WhatsAppInvites"("guest_employee_id");

DO $$ BEGIN
  ALTER TABLE "WhatsAppInvites"
    ADD CONSTRAINT "WhatsAppInvites_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
