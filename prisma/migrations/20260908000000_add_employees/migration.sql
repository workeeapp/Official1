-- CreateTable
CREATE TABLE "Employees" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "surname" VARCHAR(100) NOT NULL,
    "nickname" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employees_user_id_idx" ON "Employees"("user_id");

-- AddForeignKey
ALTER TABLE "Employees" ADD CONSTRAINT "Employees_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "Users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
