#!/usr/bin/env bash
# In-VPC spine eval — STEP 3 of 3, the driver. Runs LOCALLY.
#
# Ships step 2 + the local extraction into the VPC on a one-off `sps-etl-staging` task and brings
# three ranked lists back.
#
# Transport is asymmetric because the task role's permissions are: INBOUND uses presigned GET URLs
# (the role has NO s3:GetObject, and the ECS command override caps at 8KB — too small to carry the
# extraction inline); a presigned URL needs no task-side permission, only network. OUTBOUND is a
# plain s3:// URI written with the role's own s3:PutObject, which it does have.
#
#   ./spine-eval-dispatch.sh                 # uses ./extractions.json from step 1
#   ./spine-eval-dispatch.sh other.json
#
# Prerequisite (step 1, on the laptop — needs Bedrock, which the in-VPC role does NOT have):
#   AWS_REGION=us-east-1 npx tsx spine-eval-extract.ts <pastes.json> > extractions.json
#
# Produces one <arm>.json per entry in $ARMS, in the {id: [cwid,...]} shape sponsor-eval.sh
# consumes:
#   ACTUAL=$OUT/base.json ./sponsor-eval.sh sponsor-fixtures.json
#
# ARMS defaults to a single "base" run. To compare variants, set ARMS and have the runner behave
# differently per arm -- e.g. ARMS="base variant" with an env flag keyed off $ARM. One arm per
# PROCESS is mandatory: the extractor memo key carries no arm identity, so two arms in one node
# process would both be served the first arm's seeded extraction.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# AWS CLI v2 pipes long output into a pager by default. Any `aws` call here whose output is NOT
# captured into a variable would then block on `less` waiting for a keypress, which reads exactly
# like a hung script. Disable it for this process.
export AWS_PAGER=""

EXTRACTIONS="${1:-$DIR/extractions.json}"
BUCKET="${BUCKET:-sps-etl-staging-curationbackupbuckete5a802a9-gj1msbqkbgok}"
CLUSTER="${CLUSTER:-sps-cluster-staging}"
TASKDEF="${TASKDEF:-sps-etl-staging}"
OUT="${OUT:-$DIR/spine-eval-out}"
ARMS="${ARMS:-base}"
PREFIX="spine-eval/$(date +%Y%m%d-%H%M%S)"
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
  echo "resolving network config from the ${TASKDEF} nightly state machine..."
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

echo "staging payload -> s3://${BUCKET}/${PREFIX}/"
aws s3 cp "$EXTRACTIONS"          "s3://$BUCKET/$PREFIX/extractions.json" --only-show-errors
aws s3 cp "$DIR/spine-eval-run.ts" "s3://$BUCKET/$PREFIX/run.ts"           --only-show-errors
# Ship the arm→flag module too: run.ts imports it, and the upload-run.ts pattern exists so eval
# logic changes need NO image rebuild — the image only has to carry the spine (the rescore code).
aws s3 cp "$DIR/spine-eval-arm.ts" "s3://$BUCKET/$PREFIX/arm.ts"           --only-show-errors

GET_DATA="$(aws s3 presign "s3://$BUCKET/$PREFIX/extractions.json" --expires-in "$EXPIRY")"
GET_RUN="$(aws s3 presign  "s3://$BUCKET/$PREFIX/run.ts"           --expires-in "$EXPIRY")"
GET_ARM="$(aws s3 presign  "s3://$BUCKET/$PREFIX/arm.ts"           --expires-in "$EXPIRY")"

# One arm per PROCESS — the memo key does not include the arm and the cache has no clear, so a
# second arm in the same node process would be served the first arm's seeded extraction.
# `set -e` inside the container so a failed arm fails the task instead of uploading a partial.
# NO curl IN THE IMAGE. The etl stage is node:22-bookworm-slim + openssl/ca-certificates only, so
# `curl` exits 127. Node 22 ships a global fetch — use the runtime that is guaranteed present
# rather than apt-get installing one at task start.
#
# The runner lands UNDER /app, NOT /tmp. Node resolves bare imports (`@aws-sdk/client-s3`) by
# walking up from the FILE's own directory, so a script in /tmp never sees /app/node_modules and
# `cd /app` does not change that. Only the data file may live in /tmp — it is read by path.
#
# And it goes in scripts/search-eval/, not /app itself: `WORKDIR /app` creates that directory as
# ROOT, while `COPY --chown=node:node . .` chowns only the content it copies. The image runs as
# USER node, so creating a new file directly in /app is EACCES — but the copied SUBDIRECTORIES are
# node-owned and writable, and they still resolve up to /app/node_modules.
SCRIPT='set -e
cd /app
node -e '"'"'
const fs = require("fs");
(async () => {
  for (const [url, path] of [[process.env.GET_RUN, "/app/scripts/search-eval/_spine-eval-run.ts"], [process.env.GET_ARM, "/app/scripts/search-eval/spine-eval-arm.ts"], [process.env.GET_DATA, "/tmp/data.json"]]) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) throw new Error(`${path}: empty payload`);
    fs.writeFileSync(path, buf);
    console.error(`fetched ${path} (${buf.length} bytes)`);
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
'"'"'
for ARM in $ARMS; do
  echo "=== arm $ARM ==="
  ARM=$ARM npx tsx /app/scripts/search-eval/_spine-eval-run.ts /tmp/data.json "$OUT_BASE/$ARM.json"
done
echo "ALL ARMS DONE"'

# Outbound needs no presigning: the task role HAS s3:PutObject on this bucket (it just has no
# s3:GetObject, which is why the inbound direction does need presigned GETs). Pass a plain s3://
# prefix and let the runner put with its own role.
OUT_BASE="s3://$BUCKET/$PREFIX"

echo "launching one-off task on ${TASKDEF}..."
TASK_ARN="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASKDEF" \
  --launch-type FARGATE \
  --network-configuration "$NETCFG" \
  --overrides "$(jq -n \
      --arg s "$SCRIPT" --arg gr "$GET_RUN" --arg ga "$GET_ARM" --arg gd "$GET_DATA" \
      --arg ob "$OUT_BASE" --arg ar "$ARMS" --arg iw "${MATCHA_GLOSS_INWORDS:-}" \
      '{containerOverrides:[{name:"etl",command:["bash","-c",$s],environment:(
         [{name:"GET_RUN",value:$gr},{name:"GET_ARM",value:$ga},{name:"GET_DATA",value:$gd},
          {name:"OUT_BASE",value:$ob},{name:"ARMS",value:$ar}]
         + (if $iw != "" then [{name:"MATCHA_GLOSS_INWORDS",value:$iw}] else [] end))}]}')" \
  --query 'tasks[0].taskArn' --output text)"

[[ -n "$TASK_ARN" && "$TASK_ARN" != "None" ]] || { echo "run-task returned no ARN" >&2; exit 1; }
echo "task: $TASK_ARN"
# `aws ecs wait tasks-stopped` is a FIXED 100 x 6s = 10 minutes with no way to extend, and it exits
# non-zero on timeout — which would abort this script before the download step even though the
# results may already be in S3. Poll instead, with a ceiling generous enough for three arms.
echo "waiting (retrieval is ~15 OpenSearch fan-outs per arm; several minutes)..."
DEADLINE=$(( SECONDS + ${WAIT_MAX:-2400} ))
while :; do
  STATUS="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
    --query 'tasks[0].lastStatus' --output text)"
  [[ "$STATUS" == "STOPPED" ]] && break
  if (( SECONDS > DEADLINE )); then
    echo "still $STATUS after ${WAIT_MAX:-2400}s — giving up on the wait, NOT on the results." >&2
    echo "  logs: aws logs tail /aws/ecs/$TASKDEF --since 1h" >&2
    echo "  then re-run just the download against: s3://$BUCKET/$PREFIX/" >&2
    exit 1
  fi
  sleep 10
done

CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
REASON="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)"
echo "exit=$CODE reason=$REASON"
if [[ "$CODE" != "0" ]]; then
  echo "task failed — logs (note the /aws/ prefix; the group is NOT /ecs/...):" >&2
  echo "  aws logs tail /aws/ecs/$TASKDEF --since 30m" >&2
  exit 1
fi

for arm in $ARMS; do
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
echo "-> $OUT/ ($ARMS)"
echo "score with:  cd $DIR && ACTUAL=$OUT/<arm>.json ./sponsor-eval.sh sponsor-fixtures.json"
