-- Anti-abuse SenderBlock: recipient blocks external assign/notify sender.
CREATE TABLE "SenderBlocks" (
    "id" UUID NOT NULL,
    "blocker_phone" VARCHAR(32) NOT NULL,
    "blocked_phone" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SenderBlocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SenderBlocks_blocker_phone_blocked_phone_key" ON "SenderBlocks"("blocker_phone", "blocked_phone");

CREATE INDEX "SenderBlocks_blocked_phone_idx" ON "SenderBlocks"("blocked_phone");
