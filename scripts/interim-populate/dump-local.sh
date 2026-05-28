#!/usr/bin/env bash
# Interim data-population (#483): dump a locally-populated SPS database for
# loading into Aurora. Runs on a WCM-connected host AFTER the source ETLs have
# filled the local DB (see docs/data-population-runbook.md §7.1-§7.2).
#
# Produces a gzip, DATA-ONLY dump with a FOREIGN_KEY_CHECKS=0 + per-table
# TRUNCATE preamble so a reload fully REPLACES target data. Excludes
# `_prisma_migrations` (Aurora's migration history is authoritative). Data-only
# (no DDL) keeps the dump portable across the local MariaDB -> Aurora MySQL
# engine difference; the Aurora schema is already Prisma-migrated.
#
# Usage:
#   scripts/interim-populate/dump-local.sh <mysql-url> <out.sql.gz>
#   e.g. scripts/interim-populate/dump-local.sh \
#          'mysql://scholars:scholars@127.0.0.1:3306/scholars' /tmp/sps-data.sql.gz

set -euo pipefail

URL="${1:?usage: dump-local.sh <mysql-url> <out.sql.gz>}"
OUT="${2:?usage: dump-local.sh <mysql-url> <out.sql.gz>}"

# Parse mysql://user:pass@host:port/db
re='^mysql://([^:]+):([^@]+)@([^:/]+):?([0-9]*)/([^?]+)'
[[ "$URL" =~ $re ]] || { echo "error: cannot parse mysql url" >&2; exit 1; }
DB_USER="${BASH_REMATCH[1]}"
DB_PASS="${BASH_REMATCH[2]}"
DB_HOST="${BASH_REMATCH[3]}"
DB_PORT="${BASH_REMATCH[4]:-3306}"
DB_NAME="${BASH_REMATCH[5]}"

export MYSQL_PWD="$DB_PASS"   # keep the password off the process arg list
# --no-defaults FIRST: this host's ~/.my.cnf routes to a remote server otherwise,
# overriding -h and causing "Access denied" (documented local-dev gotcha).
mc=(--no-defaults -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --default-character-set=utf8mb4)

echo "Enumerating base tables in ${DB_NAME} (excluding _prisma_migrations)..." >&2
# read loop (not mapfile) -- macOS ships bash 3.2, which predates mapfile.
TABLES=()
while IFS= read -r t; do [[ -n "$t" ]] && TABLES+=("$t"); done < <(mysql "${mc[@]}" -N -B -e \
  "SELECT table_name FROM information_schema.tables
    WHERE table_schema='${DB_NAME}' AND table_type='BASE TABLE'
      AND table_name <> '_prisma_migrations' ORDER BY table_name;")
[[ "${#TABLES[@]}" -gt 0 ]] || { echo "error: no tables found (check creds / --no-defaults)" >&2; exit 1; }
echo "  ${#TABLES[@]} tables" >&2

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{
  echo "-- SPS interim data load (#483) -- generated $(date -u +%FT%TZ)"
  echo "SET FOREIGN_KEY_CHECKS=0;"
  echo "SET UNIQUE_CHECKS=0;"
  for t in "${TABLES[@]}"; do echo "TRUNCATE TABLE \`${t}\`;"; done
} > "$TMP"

echo "Dumping data (this can take a few minutes for the full corpus)..." >&2
# --complete-insert: column-named INSERTs, so the load survives column-order
#   differences and tolerates the Aurora target being a schema SUPERSET of the
#   local source (extra Aurora columns take their defaults). A genuine mismatch
#   (a column local has that Aurora lacks) then fails LOUDLY at load, never
#   silently. This matters because the local dev DB can lag the repo migrations.
# --no-create-info: data only; Aurora's schema is already Prisma-migrated.
mysqldump --no-defaults -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
  --default-character-set=utf8mb4 \
  --no-create-info --complete-insert --skip-triggers --no-tablespaces \
  --single-transaction --quick --skip-add-locks \
  --ignore-table="${DB_NAME}._prisma_migrations" \
  "$DB_NAME" >> "$TMP"

echo "SET FOREIGN_KEY_CHECKS=1;" >> "$TMP"
echo "SET UNIQUE_CHECKS=1;" >> "$TMP"

gzip -c "$TMP" > "$OUT"
echo "Wrote ${OUT} ($(du -h "$OUT" | cut -f1))." >&2
