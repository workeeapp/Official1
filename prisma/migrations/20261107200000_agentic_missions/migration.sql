-- Hidden mission executor flag on digital employees
ALTER TABLE "Employees" ADD COLUMN IF NOT EXISTS "is_executor" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "Employees_user_id_is_executor_idx" ON "Employees"("user_id", "is_executor");

-- Missions
CREATE TABLE IF NOT EXISTS "Missions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "speaker_id" UUID NOT NULL,
    "orchestrator_id" UUID NOT NULL,
    "executor_id" UUID NOT NULL,
    "goal" TEXT NOT NULL,
    "success_criteria" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'open',
    "plan" JSONB NOT NULL DEFAULT '[]',
    "plan_updated_at" TIMESTAMP(3),
    "plan_approved_at" TIMESTAMP(3),
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "context_facts" JSONB NOT NULL DEFAULT '[]',
    "last_summary" TEXT NOT NULL DEFAULT '',
    "waiting_on" VARCHAR(64) NOT NULL DEFAULT '',
    "step_count" INTEGER NOT NULL DEFAULT 0,
    "max_steps" INTEGER NOT NULL DEFAULT 40,
    "tracking_item_id" UUID,
    "wake_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Missions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Missions_tracking_item_id_key" ON "Missions"("tracking_item_id");
CREATE INDEX IF NOT EXISTS "Missions_user_id_status_idx" ON "Missions"("user_id", "status");
CREATE INDEX IF NOT EXISTS "Missions_speaker_id_status_idx" ON "Missions"("speaker_id", "status");
CREATE INDEX IF NOT EXISTS "Missions_orchestrator_id_status_idx" ON "Missions"("orchestrator_id", "status");
CREATE INDEX IF NOT EXISTS "Missions_wake_at_idx" ON "Missions"("wake_at");

ALTER TABLE "Missions"
  ADD CONSTRAINT "Missions_speaker_id_fkey"
  FOREIGN KEY ("speaker_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Missions"
  ADD CONSTRAINT "Missions_orchestrator_id_fkey"
  FOREIGN KEY ("orchestrator_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Missions"
  ADD CONSTRAINT "Missions_executor_id_fkey"
  FOREIGN KEY ("executor_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Missions"
  ADD CONSTRAINT "Missions_tracking_item_id_fkey"
  FOREIGN KEY ("tracking_item_id") REFERENCES "EmployeeListItems"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Mission tool calls
CREATE TABLE IF NOT EXISTS "MissionToolCalls" (
    "id" UUID NOT NULL,
    "mission_id" UUID NOT NULL,
    "tool" VARCHAR(64) NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending',
    "result_summary" TEXT NOT NULL DEFAULT '',
    "evidence_attachment_ids" JSONB NOT NULL DEFAULT '[]',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "approval_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionToolCalls_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MissionToolCalls_mission_id_status_idx" ON "MissionToolCalls"("mission_id", "status");
CREATE INDEX IF NOT EXISTS "MissionToolCalls_approval_expires_at_idx" ON "MissionToolCalls"("approval_expires_at");

ALTER TABLE "MissionToolCalls"
  ADD CONSTRAINT "MissionToolCalls_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "Missions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Speaker-scoped encrypted secrets
CREATE TABLE IF NOT EXISTS "SecretVaults" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "speaker_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "site" VARCHAR(255) NOT NULL DEFAULT '',
    "ciphertext" TEXT NOT NULL,
    "iv" VARCHAR(64) NOT NULL,
    "auth_tag" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "SecretVaults_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SecretVaults_user_id_speaker_id_idx" ON "SecretVaults"("user_id", "speaker_id");
CREATE INDEX IF NOT EXISTS "SecretVaults_speaker_id_kind_idx" ON "SecretVaults"("speaker_id", "kind");

ALTER TABLE "SecretVaults"
  ADD CONSTRAINT "SecretVaults_speaker_id_fkey"
  FOREIGN KEY ("speaker_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Attachment links → missions
ALTER TABLE "AttachmentLinks" DROP CONSTRAINT IF EXISTS "AttachmentLinks_one_target";
ALTER TABLE "AttachmentLinks" ADD COLUMN IF NOT EXISTS "mission_id" UUID;
ALTER TABLE "AttachmentLinks"
  ADD CONSTRAINT "AttachmentLinks_one_target" CHECK (
    num_nonnulls("list_id", "list_item_id", "filing_id", "reminder_id", "contact_id", "mission_id") = 1
  );
CREATE UNIQUE INDEX IF NOT EXISTS "AttachmentLinks_attachment_id_mission_id_key"
  ON "AttachmentLinks"("attachment_id", "mission_id");
CREATE INDEX IF NOT EXISTS "AttachmentLinks_mission_id_idx" ON "AttachmentLinks"("mission_id");
ALTER TABLE "AttachmentLinks"
  ADD CONSTRAINT "AttachmentLinks_mission_id_fkey"
  FOREIGN KEY ("mission_id") REFERENCES "Missions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
