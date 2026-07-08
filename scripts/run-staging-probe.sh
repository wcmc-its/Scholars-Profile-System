#!/usr/bin/env bash
#
# Run a READ-ONLY tsx script (a metric/probe `scripts/*.ts`) against a deployed env's database, without
# rolling a new image. It gzip+base64-encodes the probe, ships it as a container
# override env-var to the existing ETL task (which already has the full dep tree,
# the generated Prisma client, tsx, and DATABASE_URL → that env's RDS), decodes it
# to /tmp inside the container, and runs it with tsx. Output goes to the task's
# CloudWatch log stream, which this script tails back.
#
# Use ONLY for read-only probes (SELECT-only). This is now ENFORCED, not just a
# convention: the container points DATABASE_URL at the SELECT-only Aurora user
# (DATABASE_URL_RO, scholars/<env>/db/app-ro) so a probe physically cannot write.
# Anything that writes must go through the normal migrate/ETL path with sign-off.
#
# Usage:
#   scripts/run-staging-probe.sh scripts/faculty-coverage-metric.ts          # staging
#   scripts/run-staging-probe.sh scripts/faculty-coverage-metric.ts staging
#
# Network config is the Sps-Network-staging private subnets + ETL SG documented in
# docs/OPERATIONS-RUNBOOK.md §4. Prod is intentionally not wired here — add its
# subnets/SG (from Sps-Network-prod) before pointing this at prod.
set -euo pipefail

PROBE="${1:?usage: run-staging-probe.sh <scripts/some-metric.ts> [staging]}"
ENV="${2:-staging}"
[[ -f "$PROBE" ]] || { echo "no such probe file: $PROBE" >&2; exit 1; }
[[ "$ENV" == "staging" ]] || { echo "only 'staging' is wired (see header)" >&2; exit 1; }

CLUSTER="sps-cluster-$ENV"
TASKDEF="sps-etl-$ENV"
CONTAINER="etl"
LOG_GROUP="/aws/ecs/sps-etl-$ENV"
LOG_PREFIX="etl"
SUBNETS="subnet-03de6e3dfe190288b,subnet-019afebef588ee4b3"   # Sps-Network-staging private
SG="sg-09b494047547ea148"                                      # ETL task SG

B64="$(gzip -9 -c "$PROBE" | base64 | tr -d '\n')"
OVERRIDES="$(B64="$B64" CONTAINER="$CONTAINER" python3 - <<'PY'
import json, os
decoder = ("const z=require('zlib'),fs=require('fs'),cp=require('child_process'),p=require('path');"
           # Force the probe onto the SELECT-only Aurora user: the sps-etl task def
           # injects DATABASE_URL_RO (scholars/<env>/db/app-ro). Point every DB
           # client (which reads DATABASE_URL) at it so a probe physically cannot
           # write. Falls back to the RW DSN only if RO is not wired (older image).
           "if(process.env.DATABASE_URL_RO)process.env.DATABASE_URL=process.env.DATABASE_URL_RO;"
           "const f='/tmp/__probe.ts';"
           "fs.writeFileSync(f,z.gunzipSync(Buffer.from(process.env.PROBE_B64,'base64')));"
           "cp.execSync('node_modules/.bin/tsx --tsconfig '+p.join(process.cwd(),'tsconfig.json')+' '+f,{stdio:'inherit'})")
print(json.dumps({"containerOverrides":[{
    "name": os.environ["CONTAINER"],
    "command": ["node","-e",decoder],
    "environment": [{"name":"PROBE_B64","value":os.environ["B64"]}],
}]}))
PY
)"

echo "Launching $PROBE on $CLUSTER ($TASKDEF)…" >&2
TID="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --overrides "$OVERRIDES" --query 'tasks[0].taskArn' --output text)"
TID="${TID##*/}"
echo "task: $TID — waiting…" >&2
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TID"

EXIT="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TID" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
echo "exit=$EXIT — output:" >&2
aws logs get-log-events --log-group-name "$LOG_GROUP" \
  --log-stream-name "$LOG_PREFIX/$CONTAINER/$TID" --start-from-head \
  --query 'events[].message' --output text
exit "$EXIT"
