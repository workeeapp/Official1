-- Wave 1 C1: Prospect/Member flag on User.
-- Default false = C1-M2 grandfather (existing WhatsApp users remain Members).
-- New WhatsApp-only accounts set consent_pending=true in createWhatsAppOnlyUser (C1-A).

ALTER TABLE "Users" ADD COLUMN "consent_pending" BOOLEAN NOT NULL DEFAULT false;
