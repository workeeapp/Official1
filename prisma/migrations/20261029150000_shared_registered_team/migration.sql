-- Allow multiple teams per User (personal + "New Registered 30 days").
DROP INDEX IF EXISTS "Teams_user_id_key";
CREATE INDEX IF NOT EXISTS "Teams_user_id_idx" ON "Teams"("user_id");
CREATE INDEX IF NOT EXISTS "Teams_user_id_name_idx" ON "Teams"("user_id", "name");
