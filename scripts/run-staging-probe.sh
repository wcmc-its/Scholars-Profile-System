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
#   scripts/run-staging-probe.sh scripts/probe-576-launch.ts prod
#
# Network config is read off the LIVE `sps-app-<env>` service, so prod needed no
# subnet/SG wiring — only this guard widening. Prod carries DATABASE_URL_RO
# (scholars/prod/db/app-ro) on `sps-etl-prod`, so the SELECT-only enforcement
# below holds there identically.
set -euo pipefail

PROBE="${1:?usage: run-staging-probe.sh <scripts/some-metric.ts> [staging|prod]}"
ENV="${2:-staging}"
[[ -f "$PROBE" ]] || { echo "no such probe file: $PROBE" >&2; exit 1; }
[[ "$ENV" == "staging" || "$ENV" == "prod" ]] || { echo "env must be staging|prod" >&2; exit 1; }

CLUSTER="sps-cluster-$ENV"
TASKDEF="sps-etl-$ENV"
CONTAINER="etl"
LOG_GROUP="/aws/ecs/sps-etl-$ENV"
LOG_PREFIX="etl"
# ponytail: read the netcfg off the LIVE app service instead of hardcoding it. Pinned
# subnet/SG ids here went stale after a network redeploy and the probe then failed as a
# DB socket timeout — which reads like an outage but is just a bad launch config.
NETCFG="$(aws ecs describe-services --cluster "$CLUSTER" --services "sps-app-$ENV" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
SUBNETS="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["subnets"]))' <<<"$NETCFG")"
SG="$(python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["securityGroups"]))' <<<"$NETCFG")"
[[ -n "$SUBNETS" && -n "$SG" ]] || { echo "could not read live netcfg for $ENV" >&2; exit 1; }

B64="$(gzip -9 -c "$PROBE" | base64 | tr -d '\n')"
OVERRIDES="$(B64="$B64" CONTAINER="$CONTAINER" PROBE_KEEP_RW="${PROBE_KEEP_RW:-}" python3 - <<'PY'
import json, os
decoder = ("const z=require('zlib'),fs=require('fs'),cp=require('child_process'),p=require('path');"
           # Force the probe onto the SELECT-only Aurora user: the sps-etl task def
           # injects DATABASE_URL_RO (scholars/<env>/db/app-ro). Point every DB
           # client (which reads DATABASE_URL) at it so a probe physically cannot
           # write. Falls back to the RW DSN only if RO is not wired (older image).
           # PROBE_KEEP_RW=1 keeps the ORIGINAL (writer) DSN reachable as
           # DATABASE_URL_RW. Off by default so the SELECT-only contract above is
           # unchanged; the one probe that needs it (#2204) uses it solely for
           # `SHOW GRANTS FOR CURRENT_USER()`, which no other connection can answer
           # -- a least-privilege role cannot read the grants of another role.
           # (Keep apostrophes out of this heredoc: bash parses it inside $(...).)
           "if(process.env.PROBE_KEEP_RW)process.env.DATABASE_URL_RW=process.env.DATABASE_URL;"
           "if(process.env.DATABASE_URL_RO)process.env.DATABASE_URL=process.env.DATABASE_URL_RO;"
           # Land the probe in scripts/ inside the app tree, NOT /tmp. Node resolves
           # bare specifiers by walking UP from the importing file, so a probe in
           # /tmp missed /app/node_modules entirely and any `import ... from "mariadb"`
           # died with MODULE_NOT_FOUND -- as did any relative `./db-bootstrap`.
           # Writing it where the real scripts live makes bare deps, sibling-relative
           # imports and the @/ tsconfig alias all resolve exactly as they do locally.
           "const f=p.join(process.cwd(),'scripts','__probe.ts');"
           "fs.mkdirSync(p.dirname(f),{recursive:true});"
           "fs.writeFileSync(f,z.gunzipSync(Buffer.from(process.env.PROBE_B64,'base64')));"
           "cp.execSync('node_modules/.bin/tsx --tsconfig '+p.join(process.cwd(),'tsconfig.json')+' '+f,{stdio:'inherit'})")
environment = [{"name": "PROBE_B64", "value": os.environ["B64"]}]
if os.environ.get("PROBE_KEEP_RW"):
    environment.append({"name": "PROBE_KEEP_RW", "value": "1"})
print(json.dumps({"containerOverrides":[{
    "name": os.environ["CONTAINER"],
    "command": ["node","-e",decoder],
    "environment": environment,
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
