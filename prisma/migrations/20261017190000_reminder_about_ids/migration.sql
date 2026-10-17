-- Who a reminder is about (e.g. birthday of X) — distinct from ping_ids (who gets WhatsApp).
ALTER TABLE "Reminders" ADD COLUMN "about_ids" JSONB NOT NULL DEFAULT '[]';
