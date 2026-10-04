-- Platform admin flag on login Users (separate from Employees.is_owner).
ALTER TABLE "Users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT false;
