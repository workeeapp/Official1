-- CreateTable
CREATE TABLE "WhatsAppInbounds" (
    "phone" VARCHAR(32) NOT NULL,
    "last_inbound_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppInbounds_pkey" PRIMARY KEY ("phone")
);
