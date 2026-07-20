#!/usr/bin/env bash
# MATCHA_GLOSS_QUERY A/B — STEP 3 of 3, the driver. Runs LOCALLY.
#
# Ships step 2 + the local extraction into the VPC on a one-off `sps-etl-staging` task and brings
# three ranked lists back. Transport is PRESIGNED URLs, not task IAM: that role can PutObject but
# has NO s3:GetObject, and the ECS command override caps at 8KB — too small for the extraction.
# A presigned URL needs no permissions on the task side, only network, which this task has.
#
#   ./gloss-ab-dispatch.sh <extractions.json>
#
# Produces off.json / substitute.json / append.json in $OUT, in the {id: [cwid,...]} shape
# sponsor-eval.sh already consumes:
#   ACTUAL=off.json ./sponsor-eval.sh sponsor-fixtures.json > off.txt
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXTRACTIONS="${1:?usage: gloss-ab-dispatch.sh <extractions.json>}"
BUCKET="${BUCKET:-sps-etl-staging-curationbackupbuckete5a802a9-gj1msbqkbgok}"
CLUSTER="${CLUSTER:-sps-cluster-staging}"
TASKDEF="${TASKDEF:-sps-etl-staging}"
OUT="${OUT:-$DIR/gloss-ab-out}"
PREFIX="gloss-ab/$(date +%Y%m%d-%H%M%S)"
EXPIRY="${EXPIRY:-7200}"

[[ -f "$EXTRACTIONS" ]] || { echo "no extractions at $EXTRACTIONS" >&2; exit 1; }
mkdir -p "$OUT"

# Network config is not on the task def for a one-off run-task — read the service's own so the
# task lands in the same subnets/SGs the ETL normally uses.
echo "resolving network config from the ETL service…"
SVC="$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[?contains(@,`etl`)]' --output text | head -1)"
if [[ -n "$SVC" ]]; then
  NETCFG="$(aws ecs describe-services --cluster "$CLUSTER" --services "$SVC" \
    --query 'services[0].networkConfiguration' --output json)"
else
  # The ETL runs as scheduled tasks, not a service — fall back to the Step Functions state machine.
  NETCFG="${NETCFG:?no etl service found; export NETCFG='{\"awsvpcConfiguration\":{...}}'}"
fi
[[ "$NETCFG" != "null" ]] || { echo "could not resolve networkConfiguration; export NETCFG=…" >&2; exit 1; }

echo "staging payload → s3://$BUCKET/$PREFIX/"
aws s3 cp "$EXTRACTIONS"          "s3://$BUCKET/$PREFIX/extractions.json" --only-show-errors
aws s3 cp "$DIR/gloss-ab-run.ts"  "s3://$BUCKET/$PREFIX/run.ts"           --only-show-errors

GET_DATA="$(aws s3 presign "s3://$BUCKET/$PREFIX/extractions.json" --expires-in "$EXPIRY")"
GET_RUN="$(aws s3 presign  "s3://$BUCKET/$PREFIX/run.ts"           --expires-in "$EXPIRY")"

# One arm per PROCESS — the memo key does not include the arm and the cache has no clear, so a
# second arm in the same node process would be served the first arm's seeded extraction.
# `set -e` inside the container so a failed arm fails the task instead of uploading a partial.
SCRIPT='set -e
cd /app
curl -fsSL "$GET_RUN"  -o /tmp/run.ts
curl -fsSL "$GET_DATA" -o /tmp/data.json
for ARM in off substitute append; do
  echo "=== arm $ARM ==="
  eval "PUT=\$PUT_$ARM"
  ARM=$ARM npx tsx /tmp/run.ts /tmp/data.json "$PUT"
done
echo "ALL ARMS DONE"'

# Outbound needs no presigning: the task role HAS s3:PutObject on this bucket (it just has no
# s3:GetObject, which is why the inbound direction does need presigned GETs). Pass plain s3:// URIs
# and let the runner put with its own role.
PUT_OFF="s3://$BUCKET/$PREFIX/off.json"
PUT_SUB="s3://$BUCKET/$PREFIX/substitute.json"
PUT_APP="s3://$BUCKET/$PREFIX/append.json"

echo "launching one-off task on $TASKDEF…"
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "$NETCFG" \
  --overrides "$(jq -n \
      --arg s "$SCRIPT" --arg gr "$GET_RUN" --arg gd "$GET_DATA" \
      --arg po "$PUT_OFF" --arg ps "$PUT_SUB" --arg pa "$PUT_APP" \
      '{containerOverrides:[{name:"etl",command:["bash","-c",$s],environment:[
         {name:"GET_RUN",value:$gr},{name:"GET_DATA",value:$gd},
         {name:"PUT_off",value:$po},{name:"PUT_substitute",value:$ps},{name:"PUT_append",value:$pa}]}]}')" \
  --query 'tasks[0].taskArn' --output text)"

[[ -n "$TASK_ARN" && "$TASK_ARN" != "None" ]] || { echo "run-task returned no ARN" >&2; exit 1; }
echo "task: $TASK_ARN"
echo "waiting (retrieval is ~15 OpenSearch fan-outs per arm; several minutes)…"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
REASON="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)"
echo "exit=$CODE reason=$REASON"
if [[ "$CODE" != "0" ]]; then
  echo "task failed — logs:" >&2
  echo "  aws logs tail /ecs/sps-etl-staging --since 30m" >&2
  exit 1
fi

for arm in off substitute append; do
  aws s3 cp "s3://$BUCKET/$PREFIX/$arm.json" "$OUT/$arm.raw.json" --only-show-errors
  # sponsor-eval.sh wants a bare {id: [cwid,...]}; keep the audit fields beside it.
  jq '.ranked' "$OUT/$arm.raw.json" > "$OUT/$arm.json"
  n="$(jq 'length' "$OUT/$arm.json")"
  u="$(jq '.unmeasured | length' "$OUT/$arm.raw.json")"
  echo "  $arm: $n fixtures ranked, $u unmeasured"
  # An unmeasured fixture is a MEASUREMENT FAILURE, not a zero — say so loudly rather than
  # letting sponsor-eval.sh score its absence as a miss.
  jq -e '.unmeasured | length == 0' "$OUT/$arm.raw.json" >/dev/null \
    || jq -r '.unmeasured[] | "    ⚠ \(.id): \(.why)"' "$OUT/$arm.raw.json"
done

echo
echo "→ $OUT/{off,substitute,append}.json"
echo "score with:  cd $DIR && ACTUAL=$OUT/append.json ./sponsor-eval.sh sponsor-fixtures.json"
