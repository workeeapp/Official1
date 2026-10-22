#!/bin/bash
# First-boot only (empty data volume). Creates workee_test + non-superuser workee_eval.
# Does not create a database named workee (product identity) on this instance.
set -euo pipefail

if [ -z "${WORKEE_EVAL_PASSWORD:-}" ]; then
  echo "WORKEE_EVAL_PASSWORD is required" >&2
  exit 1
fi

# Alphanumeric passwords only (set by host). Use dollar-quoting for safety.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workee_eval') THEN
    EXECUTE format(
      'CREATE ROLE workee_eval LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      '${WORKEE_EVAL_PASSWORD}'
    );
  END IF;
END
\$\$;
EOSQL

EXISTS_DB="$(psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -tAc "SELECT 1 FROM pg_database WHERE datname = 'workee_test'")"
if [ "${EXISTS_DB// /}" != "1" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -c "CREATE DATABASE workee_test OWNER workee_eval"
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER DATABASE workee_test OWNER TO workee_eval"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "workee_test" <<EOSQL
GRANT CONNECT, TEMPORARY ON DATABASE workee_test TO workee_eval;
GRANT USAGE, CREATE ON SCHEMA public TO workee_eval;
ALTER SCHEMA public OWNER TO workee_eval;
EOSQL

echo "live-full-eval init: workee_test + workee_eval ready"
