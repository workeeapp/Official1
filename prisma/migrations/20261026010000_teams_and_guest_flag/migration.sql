-- One team per User; guests are flagged and have no team.

CREATE TABLE "Teams" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Teams_user_id_key" ON "Teams"("user_id");

ALTER TABLE "Teams" ADD CONSTRAINT "Teams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Employees" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Employees" ADD COLUMN "team_id" UUID;

-- One team per existing user (name = username).
INSERT INTO "Teams" ("id", "user_id", "name", "created_at", "updated_at")
SELECT gen_random_uuid(), u."id", u."username", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Users" u;

-- Backfill WhatsApp guest shells from the prior name/nickname convention.
UPDATE "Employees"
SET "is_guest" = true
WHERE "kind" <> 'digital'
  AND (
    TRIM("name") = 'אורח'
    OR TRIM(COALESCE("nickname", '')) = 'אורח'
    OR TRIM(COALESCE("nickname", '')) LIKE 'אורח %'
  );

-- Non-guests belong to the account's team.
UPDATE "Employees" e
SET "team_id" = t."id"
FROM "Teams" t
WHERE t."user_id" = e."user_id"
  AND e."is_guest" = false;

CREATE INDEX "Employees_team_id_idx" ON "Employees"("team_id");

ALTER TABLE "Employees" ADD CONSTRAINT "Employees_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "Teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
