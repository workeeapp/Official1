-- M1–M3: PendingHighRiskConfirm + DeliveryAttempt (durable V confirm + outbound ledger)

CREATE TABLE "PendingHighRiskConfirms" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "speaker_employee_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(32) NOT NULL,
    "conversation_id" UUID,
    "action_kind" VARCHAR(64) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary_text" TEXT NOT NULL,
    "summary_hash" VARCHAR(64) NOT NULL,
    "confirm_command" VARCHAR(128) NOT NULL,
    "cancel_command" VARCHAR(128) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending_offer',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "offer_chat_message_id" UUID,
    "offer_wamid" VARCHAR(128),
    "consumed_at" TIMESTAMP(3),
    "cancel_reason" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingHighRiskConfirms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingHighRiskConfirms_confirm_command_key" ON "PendingHighRiskConfirms"("confirm_command");
CREATE UNIQUE INDEX "PendingHighRiskConfirms_cancel_command_key" ON "PendingHighRiskConfirms"("cancel_command");
CREATE INDEX "PendingHighRiskConfirms_user_id_speaker_employee_id_status_idx" ON "PendingHighRiskConfirms"("user_id", "speaker_employee_id", "status");
CREATE INDEX "PendingHighRiskConfirms_recipient_phone_status_idx" ON "PendingHighRiskConfirms"("recipient_phone", "status");
CREATE INDEX "PendingHighRiskConfirms_expires_at_idx" ON "PendingHighRiskConfirms"("expires_at");

ALTER TABLE "PendingHighRiskConfirms" ADD CONSTRAINT "PendingHighRiskConfirms_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeliveryAttempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "confirm_id" UUID,
    "step_key" VARCHAR(255) NOT NULL,
    "destination" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'queued',
    "provider_message_id" VARCHAR(128),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryAttempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryAttempts_confirm_id_step_key_key" ON "DeliveryAttempts"("confirm_id", "step_key");
CREATE INDEX "DeliveryAttempts_user_id_status_idx" ON "DeliveryAttempts"("user_id", "status");
CREATE INDEX "DeliveryAttempts_status_updated_at_idx" ON "DeliveryAttempts"("status", "updated_at");

ALTER TABLE "DeliveryAttempts" ADD CONSTRAINT "DeliveryAttempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryAttempts" ADD CONSTRAINT "DeliveryAttempts_confirm_id_fkey" FOREIGN KEY ("confirm_id") REFERENCES "PendingHighRiskConfirms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
