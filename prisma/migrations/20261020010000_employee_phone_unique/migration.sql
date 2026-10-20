-- Normalize existing phones to canonical WhatsApp digits (IL 0… → 972…).
UPDATE "Employees"
SET "phone" = NULL
WHERE "phone" IS NOT NULL AND btrim("phone") = '';

UPDATE "Employees" e
SET "phone" = (
  CASE
    WHEN d.digits = '' THEN NULL
    WHEN d.digits ~ '^0[0-9]{8,9}$' THEN '972' || substr(d.digits, 2)
    ELSE d.digits
  END
)
FROM (
  SELECT
    id,
    regexp_replace(COALESCE("phone", ''), '\D', '', 'g') AS digits
  FROM "Employees"
  WHERE "phone" IS NOT NULL
) AS d
WHERE e.id = d.id;

-- If duplicates remain after normalize, keep one row (prefer non-אורח) and clear the rest.
WITH ranked AS (
  SELECT
    id,
    "phone",
    ROW_NUMBER() OVER (
      PARTITION BY "phone"
      ORDER BY
        CASE
          WHEN "name" = 'אורח' OR COALESCE("nickname", '') = 'אורח'
            OR COALESCE("nickname", '') LIKE 'אורח %' THEN 1
          ELSE 0
        END ASC,
        "created_at" ASC
    ) AS rn
  FROM "Employees"
  WHERE "phone" IS NOT NULL
)
UPDATE "Employees" e
SET "phone" = NULL
FROM ranked
WHERE e.id = ranked.id
  AND ranked.rn > 1;

-- CreateIndex
CREATE UNIQUE INDEX "Employees_phone_key" ON "Employees"("phone");
