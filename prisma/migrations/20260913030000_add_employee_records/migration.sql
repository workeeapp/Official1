-- AlterTable
ALTER TABLE "ChatConversations" ADD COLUMN "context_injected_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmployeeLists" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "list_type" VARCHAR(32) NOT NULL,
    "name" VARCHAR(100) NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeLists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeListItems" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "item_key" VARCHAR(255) NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeListItems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeFilings" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "item_name" VARCHAR(200) NOT NULL,
    "item_info" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeFilings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeLists_employee_id_list_type_name_key" ON "EmployeeLists"("employee_id", "list_type", "name");

-- CreateIndex
CREATE INDEX "EmployeeLists_employee_id_idx" ON "EmployeeLists"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeListItems_list_id_item_key_key" ON "EmployeeListItems"("list_id", "item_key");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeFilings_employee_id_item_name_key" ON "EmployeeFilings"("employee_id", "item_name");

-- CreateIndex
CREATE INDEX "EmployeeFilings_employee_id_idx" ON "EmployeeFilings"("employee_id");

-- AddForeignKey
ALTER TABLE "EmployeeLists" ADD CONSTRAINT "EmployeeLists_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "Employees"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeListItems" ADD CONSTRAINT "EmployeeListItems_list_id_fkey"
    FOREIGN KEY ("list_id") REFERENCES "EmployeeLists"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeFilings" ADD CONSTRAINT "EmployeeFilings_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "Employees"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
