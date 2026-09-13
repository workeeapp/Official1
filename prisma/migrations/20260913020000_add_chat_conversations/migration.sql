-- CreateTable
CREATE TABLE "ChatConversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "openai_conversation_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatConversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "author" VARCHAR(16) NOT NULL,
    "speaker" VARCHAR(100) NOT NULL,
    "text" TEXT NOT NULL,
    "actions" JSONB,
    "raw" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatConversations_user_id_employee_id_key" ON "ChatConversations"("user_id", "employee_id");

-- CreateIndex
CREATE INDEX "ChatConversations_user_id_idx" ON "ChatConversations"("user_id");

-- CreateIndex
CREATE INDEX "ChatMessages_conversation_id_created_at_idx" ON "ChatMessages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "ChatConversations" ADD CONSTRAINT "ChatConversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "Users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatConversations" ADD CONSTRAINT "ChatConversations_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "Employees"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessages" ADD CONSTRAINT "ChatMessages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ChatConversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
