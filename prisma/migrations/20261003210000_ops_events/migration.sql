-- CreateTable
CREATE TABLE "OpsEvents" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "alert_key" VARCHAR(64) NOT NULL,
    "step" VARCHAR(64) NOT NULL,
    "detail" VARCHAR(500) NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsEvents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpsEvents_kind_alert_key_created_at_idx" ON "OpsEvents"("kind", "alert_key", "created_at");

-- CreateIndex
CREATE INDEX "OpsEvents_created_at_idx" ON "OpsEvents"("created_at");
