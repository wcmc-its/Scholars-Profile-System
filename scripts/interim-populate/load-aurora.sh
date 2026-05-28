#!/usr/bin/env bash
# Interim data-population (#483): load a local dump into SPS Aurora over an
# SSM port-forward. Runs on the host that has the dump + AWS creds, AFTER an
# `aws ssm start-session ... AWS-StartPortForwardingSessionToRemoteHost` tunnel
# to the Aurora writer is up (see docs/data-population-runbook.md §7.3).
#
# DESTRUCTIVE: the dump's preamble TRUNCATEs every data table before reloading.
# Prod is gated behind CONFIRM_PROD=yes.
#
# DB credentials come from the `scholars/<env>/db/master` Secrets Manager secret
# (full DDL/TRUNCATE rights); only the username/password/dbname are read from it
# -- the host/port are the LOCAL tunnel endpoint passed as args.
#
# Usage:
#   scripts/interim-populate/load-aurora.sh <env> <tunnel-host> <tunnel-port> <dump.sql.gz>
#   e.g. scripts/interim-populate/load-aurora.sh staging 127.0.0.1 13306 /tmp/sps-data.sql.gz
#   prod: CONFIRM_PROD=yes scripts/interim-populate/load-aurora.sh prod 127.0.0.1 13306 /tmp/sps-data.sql.gz

set -euo pipefail

ENV="${1:?usage: load-aurora.sh <env> <host> <port> <dump.sql.gz>}"
HOST="${2:?usage: load-aurora.sh <env> <host> <port> <dump.sql.gz>}"
PORT="${3:?usage: load-aurora.sh <env> <host> <port> <dump.sql.gz>}"
DUMP="${4:?usage: load-aurora.sh <env> <host> <port> <dump.sql.gz>}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

if [[ "$ENV" == "prod" && "${CONFIRM_PROD:-}" != "yes" ]]; then
  echo "refusing to load prod without CONFIRM_PROD=yes (this TRUNCATEs every table)" >&2
  exit 1
fi

[[ -f "$DUMP" ]] || { echo "error: dump not found: $DUMP" >&2; exit 1; }

echo "Reading scholars/${ENV}/db/master ..." >&2
SECRET="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "scholars/${ENV}/db/master" --query SecretString --output text)"
DB_USER="$(printf '%s' "$SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["username"])')"
DB_NAME="$(printf '%s' "$SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["dbname"])')"
export MYSQL_PWD="$(printf '%s' "$SECRET" | python3 -c 'import json,sys;print(json.load(sys.stdin)["password"])')"
unset SECRET

echo "Target: ${ENV} db '${DB_NAME}' as '${DB_USER}' via ${HOST}:${PORT}" >&2
# --no-defaults FIRST: a local ~/.my.cnf would otherwise override -h and route
# off the tunnel (documented gotcha). Harmless on a clean bastion.
mc=(--no-defaults -h "$HOST" -P "$PORT" -u "$DB_USER" --default-character-set=utf8mb4)
mysql "${mc[@]}" -e "SELECT 1;" "$DB_NAME" >/dev/null \
  || { echo "error: cannot reach Aurora through the tunnel -- is the SSM session up?" >&2; exit 1; }

echo "Loading ${DUMP} (TRUNCATE + reload; this can take a while)..." >&2
gunzip -c "$DUMP" | mysql "${mc[@]}" "$DB_NAME"

echo "Row counts after load:" >&2
mysql "${mc[@]}" "$DB_NAME" -e \
  "SELECT (SELECT COUNT(*) FROM scholar) scholars,
          (SELECT COUNT(*) FROM publication) pubs,
          (SELECT COUNT(*) FROM \`grant\`) grants,
          (SELECT COUNT(*) FROM appointment) appts,
          (SELECT COUNT(*) FROM education) edu;"
unset MYSQL_PWD
echo "Done. Next: build the index in-VPC (runbook §3) and verify (§4)." >&2
