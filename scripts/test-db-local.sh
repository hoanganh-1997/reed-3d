#!/usr/bin/env bash
# Runs migrations + SQL tests against a throwaway local Postgres database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres scripts/test-db-local.sh
set -euo pipefail
DB=reef_test_$$
createdb "$DB"
trap 'dropdb "$DB"' EXIT
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/local_shim.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"; done
psql -v ON_ERROR_STOP=1 -d "$DB" -f supabase/tests/rpc_security_test.sql
