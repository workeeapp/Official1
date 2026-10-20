-- CreateTable
CREATE TABLE "Tips" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "audience" VARCHAR(16) NOT NULL,
    "digital_employee_id" UUID,
    "trigger_kind" VARCHAR(16) NOT NULL,
    "trigger_area" VARCHAR(32),
    "trigger_op" VARCHAR(16),
    "max_shows" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TipProgress" (
    "id" UUID NOT NULL,
    "tip_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "digital_employee_id" UUID NOT NULL,
    "show_count" INTEGER NOT NULL DEFAULT 0,
    "last_shown_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TipProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tips_user_id_key_key" ON "Tips"("user_id", "key");

-- CreateIndex
CREATE INDEX "Tips_user_id_enabled_idx" ON "Tips"("user_id", "enabled");

-- CreateIndex
CREATE INDEX "Tips_digital_employee_id_idx" ON "Tips"("digital_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "TipProgress_tip_id_employee_id_digital_employee_id_key" ON "TipProgress"("tip_id", "employee_id", "digital_employee_id");

-- CreateIndex
CREATE INDEX "TipProgress_employee_id_digital_employee_id_idx" ON "TipProgress"("employee_id", "digital_employee_id");

-- AddForeignKey
ALTER TABLE "Tips" ADD CONSTRAINT "Tips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "Users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tips" ADD CONSTRAINT "Tips_digital_employee_id_fkey" FOREIGN KEY ("digital_employee_id") REFERENCES "Employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipProgress" ADD CONSTRAINT "TipProgress_tip_id_fkey" FOREIGN KEY ("tip_id") REFERENCES "Tips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipProgress" ADD CONSTRAINT "TipProgress_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TipProgress" ADD CONSTRAINT "TipProgress_digital_employee_id_fkey" FOREIGN KEY ("digital_employee_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
