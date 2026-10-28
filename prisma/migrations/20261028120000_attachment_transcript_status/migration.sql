-- STT outcome for audio attachments. NULL = legacy rows (pre-status).
ALTER TABLE "Attachments" ADD COLUMN IF NOT EXISTS "transcript_status" VARCHAR(16);
