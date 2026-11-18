-- Wave 1 Stage 2: consentAcceptedAt + PendingProspectAction ledger

ALTER TABLE "Users" ADD COLUMN "consent_accepted_at" TIMESTAMP(3);

CREATE TABLE "PendingProspectActions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "speaker_employee_id" UUID NOT NULL,
    "recipient_phone" VARCHAR(32),
    "action_kind" VARCHAR(32) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "summary_text" TEXT NOT NULL,
    "join_command" VARCHAR(128) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingProspectActions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingProspectActions_join_command_key" ON "PendingProspectActions"("join_command");
CREATE INDEX "PendingProspectActions_user_id_status_idx" ON "PendingProspectActions"("user_id", "status");
CREATE INDEX "PendingProspectActions_expires_at_idx" ON "PendingProspectActions"("expires_at");

ALTER TABLE "PendingProspectActions" ADD CONSTRAINT "PendingProspectActions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
