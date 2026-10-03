-- Account owner flag on a human employee (at most one true per user in app logic).
ALTER TABLE "Employees" ADD COLUMN "is_owner" BOOLEAN NOT NULL DEFAULT false;
