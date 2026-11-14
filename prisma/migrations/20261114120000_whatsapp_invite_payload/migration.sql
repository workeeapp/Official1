-- Deferred share/assign action for an unregistered phone contact.
-- Null keeps a legacy message invite on the Phase 1 path.
ALTER TABLE "WhatsAppInvites" ADD COLUMN IF NOT EXISTS "payload" JSONB;
