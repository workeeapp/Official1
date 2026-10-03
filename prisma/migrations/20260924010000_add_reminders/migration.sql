-- CreateTable
CREATE TABLE "Reminders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "item_key" VARCHAR(255) NOT NULL,
    "item_label" VARCHAR(255) NOT NULL,
    "list_type" VARCHAR(32) NOT NULL,
    "fire_at" TIMESTAMP(3) NOT NULL,
    "repeat" VARCHAR(16) NOT NULL DEFAULT 'once',
    "ping_ids" JSON NOT NULL DEFAULT '[]',
    "message_text" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reminders_user_id_status_fire_at_idx" ON "Reminders"("user_id", "status", "fire_at");

-- CreateIndex
CREATE INDEX "Reminders_owner_id_item_key_idx" ON "Reminders"("owner_id", "item_key");

-- AddForeignKey
ALTER TABLE "Reminders" ADD CONSTRAINT "Reminders_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "Employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reminders" ADD CONSTRAINT "Reminders_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "Employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
