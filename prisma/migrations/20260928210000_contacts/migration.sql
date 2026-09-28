-- Personal contacts phone book (POC). owner_employee_id is always set for now.
CREATE TABLE "Contacts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "owner_employee_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "kind" VARCHAR(32) NOT NULL DEFAULT 'personal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Contacts_owner_employee_id_phone_key" ON "Contacts"("owner_employee_id", "phone");
CREATE INDEX "Contacts_user_id_idx" ON "Contacts"("user_id");
CREATE INDEX "Contacts_owner_employee_id_name_idx" ON "Contacts"("owner_employee_id", "name");

ALTER TABLE "Contacts" ADD CONSTRAINT "Contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Contacts" ADD CONSTRAINT "Contacts_owner_employee_id_fkey" FOREIGN KEY ("owner_employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
