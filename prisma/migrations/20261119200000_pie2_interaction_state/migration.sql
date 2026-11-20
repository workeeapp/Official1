-- PIE-2 Interaction State: Opportunity records + InitiativePreference

CREATE TABLE "InteractionOpportunities" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "digital_employee_id" UUID NOT NULL,
    "opportunity_key" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "capability_id" VARCHAR(64),
    "status" VARCHAR(16) NOT NULL,
    "offered_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "value_at" TIMESTAMP(3),
    "conversation_id" UUID,
    "turn_ref" INTEGER,
    "suppress_until" TIMESTAMP(3),
    "suppress_indefinite" BOOLEAN NOT NULL DEFAULT false,
    "entity_ref" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InteractionOpportunities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InteractionOpportunities_employee_id_digital_employee_id_opportunity_key_status_idx"
  ON "InteractionOpportunities"("employee_id", "digital_employee_id", "opportunity_key", "status");
CREATE INDEX "InteractionOpportunities_employee_id_digital_employee_id_status_suppress_until_idx"
  ON "InteractionOpportunities"("employee_id", "digital_employee_id", "status", "suppress_until");
CREATE INDEX "InteractionOpportunities_status_offered_at_idx"
  ON "InteractionOpportunities"("status", "offered_at");

-- At most one active offered row per speaker×digital×key
CREATE UNIQUE INDEX "InteractionOpportunities_active_offered_key"
  ON "InteractionOpportunities"("employee_id", "digital_employee_id", "opportunity_key")
  WHERE "status" = 'offered';

ALTER TABLE "InteractionOpportunities"
  ADD CONSTRAINT "InteractionOpportunities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InteractionOpportunities"
  ADD CONSTRAINT "InteractionOpportunities_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InteractionOpportunities"
  ADD CONSTRAINT "InteractionOpportunities_digital_employee_id_fkey"
  FOREIGN KEY ("digital_employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InitiativePreferences" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "digital_employee_id" UUID NOT NULL,
    "mode" VARCHAR(16) NOT NULL DEFAULT 'balanced',
    "source" VARCHAR(32) NOT NULL DEFAULT 'default',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InitiativePreferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InitiativePreferences_employee_id_digital_employee_id_key"
  ON "InitiativePreferences"("employee_id", "digital_employee_id");
CREATE INDEX "InitiativePreferences_user_id_idx"
  ON "InitiativePreferences"("user_id");

ALTER TABLE "InitiativePreferences"
  ADD CONSTRAINT "InitiativePreferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InitiativePreferences"
  ADD CONSTRAINT "InitiativePreferences_employee_id_fkey"
  FOREIGN KEY ("employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InitiativePreferences"
  ADD CONSTRAINT "InitiativePreferences_digital_employee_id_fkey"
  FOREIGN KEY ("digital_employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
