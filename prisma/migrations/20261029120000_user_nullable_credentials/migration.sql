-- WhatsApp-only guest registration: credentials optional until a set-password flow exists.
ALTER TABLE "Users" ALTER COLUMN "username" DROP NOT NULL;
ALTER TABLE "Users" ALTER COLUMN "password_hash" DROP NOT NULL;
