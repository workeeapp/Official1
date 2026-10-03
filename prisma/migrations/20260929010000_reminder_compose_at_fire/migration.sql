-- Generic scheduled outbound: store a brief, compose final WhatsApp text at fire time.
ALTER TABLE "Reminders"
ADD COLUMN IF NOT EXISTS "compose_at_fire" BOOLEAN NOT NULL DEFAULT false;
