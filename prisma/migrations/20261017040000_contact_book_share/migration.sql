-- Whole phone-book co-share (partners see all rows via book visible_to).
CREATE TABLE "ContactBooks" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "owner_employee_id" UUID NOT NULL,
    "scope" VARCHAR(16) NOT NULL DEFAULT 'personal',
    "visible_to" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactBooks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContactBooks_owner_employee_id_key" ON "ContactBooks"("owner_employee_id");
CREATE INDEX "ContactBooks_user_id_idx" ON "ContactBooks"("user_id");
CREATE INDEX "ContactBooks_scope_idx" ON "ContactBooks"("scope");

ALTER TABLE "ContactBooks" ADD CONSTRAINT "ContactBooks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactBooks" ADD CONSTRAINT "ContactBooks_owner_employee_id_fkey" FOREIGN KEY ("owner_employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
