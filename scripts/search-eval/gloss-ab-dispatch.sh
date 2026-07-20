#!/usr/bin/env bash
# MATCHA_GLOSS_QUERY A/B — STEP 3 of 3, the driver. Runs LOCALLY.
#
# Ships step 2 + the local extraction into the VPC on a one-off `sps-etl-staging` task and brings
# three ranked lists back. Transport is PRESIGNED URLs, not task IAM: that role can PutObject but
# has NO s3:GetObject, and the ECS command override caps at 8KB — too small for the extraction.
# A presigned URL needs no permissions on the task side, only network, which this task has.
#
#   ./gloss-ab-dispatch.sh                 # uses ./extractions.json from step 1
#   ./gloss-ab-dispatch.sh other.json
#
# Prerequisite (step 1, on the laptop — needs Bedrock, which the in-VPC role does NOT have):
#   AWS_REGION=us-east-1 npx tsx gloss-ab-extract.ts <pastes.json> > extractions.json
#
# Produces off.json / substitute.json / append.json in $OUT, in the {id: [cwid,...]} shape
# sponsor-eval.sh already consumes:
#   ACTUAL=off.json ./sponsor-eval.sh sponsor-fixtures.json > off.txt
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXTRACTIONS="${1:-$DIR/extractions.json}"
BUCKET="${BUCKET:-sps-etl-staging-curationbackupbuckete5a802a9-gj1msbqkbgok}"
CLUSTER="${CLUSTER:-sps-cluster-staging}"
TASKDEF="${TASKDEF:-sps-etl-staging}"
OUT="${OUT:-$DIR/gloss-ab-out}"
PREFIX="gloss-ab/$(date +%Y%m%d-%H%M%S)"
EXPIRY="${EXPIRY:-7200}"

[[ -f "$EXTRACTIONS" ]] || { echo "no extractions at $EXTRACTIONS" >&2; exit 1; }
mkdir -p "$OUT"

# Network config is not on the task def, and a one-off run-task must supply it. There is NO ETL
# service to copy it from — the ETL runs as `scholars-nightly-<env>` Step Functions — so read the
# state machine's own definition and land in exactly the subnets/SGs the nightly ETL uses.
#
# Note the case change: Step Functions spells it `AwsvpcConfiguration`/`Subnets`, `run-task` wants
# `awsvpcConfiguration`/`subnets`. Resolved here rather than passed in, so no file or shell history
# ever holds subnet/sg ids — this repo is PUBLIC.
if [[ -z "${NETCFG:-}" ]]; then
  echo "resolving network config from the $TASKDEF nightly state machine…"
  SM_ARN="$(aws stepfunctions list-state-machines \
    --query "stateMachines[?name=='scholars-nightly-${TASKDEF##*-}'].stateMachineArn" --output text)"
  [[ -n "$SM_ARN" && "$SM_ARN" != "None" ]] || {
    echo "no scholars-nightly state machine found; export NETCFG='{\"awsvpcConfiguration\":{…}}'" >&2
    exit 1
  }
  NETCFG="$(aws stepfunctions describe-state-machine --state-machine-arn "$SM_ARN" \
    --query definition --output text \
    | jq -c 'first(.. | objects | select(has("NetworkConfiguration")) | .NetworkConfiguration)
             | {awsvpcConfiguration:{subnets:.AwsvpcConfiguration.Subnets,
                                     securityGroups:.AwsvpcConfiguration.SecurityGroups,
                                     assignPublicIp:(.AwsvpcConfiguration.AssignPublicIp // "DISABLED")}}')"
fi
jq -e '.awsvpcConfiguration.subnets | length > 0' <<<"$NETCFG" >/dev/null \
  || { echo "could not resolve networkConfiguration" >&2; exit 1; }
echo "  network config OK ($(jq -r '.awsvpcConfiguration.subnets|length' <<<"$NETCFG") subnets)"

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
