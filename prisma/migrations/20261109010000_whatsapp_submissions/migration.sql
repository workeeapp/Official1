-- WhatsApp request held while one of its files is missing (one row per phone).
-- New table only: no existing table or row is read or changed.

-- CreateTable
CREATE TABLE "WhatsAppSubmissions" (
    "phone" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "batch" JSONB NOT NULL,
    "received" JSONB NOT NULL,
    "missing" JSONB NOT NULL,
    "candidate" JSONB,
    "handled_ids" JSONB NOT NULL DEFAULT '[]',
    "claimed_by" VARCHAR(64),
    "claimed_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppSubmissions_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE INDEX "WhatsAppSubmissions_expires_at_idx" ON "WhatsAppSubmissions"("expires_at");
