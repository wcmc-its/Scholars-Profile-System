#!/usr/bin/env bash
#
# Run ONE deployed ETL step as a one-off operator task — e.g. a full News
# backfill (#2240) — with the same image, task family and network config the
# scheduled Step Functions run uses. Unlike run-staging-probe.sh this WRITES:
# it runs the real `npm run <script>` with its normal DB user.
#
# Usage:
#   scripts/run-etl-step.sh <npm-script> <staging|prod> [KEY=VALUE ...]
#   scripts/run-etl-step.sh etl:news prod NEWS_BACKFILL=1
#
# The task definition and network config are copied from the state that runs
# `<npm-script>` in scholars-{nightly,weekly,annual}-<env>, so an `external`
# step lands on its sources task family exactly as scheduled. Output: exit code
# plus the log tail from CloudWatch.
set -euo pipefail

SCRIPT="${1:?usage: run-etl-step.sh <npm-script> <staging|prod> [KEY=VALUE ...]}"
ENV="${2:?usage: run-etl-step.sh <npm-script> <staging|prod> [KEY=VALUE ...]}"
shift 2
[[ "$ENV" == staging || "$ENV" == prod ]] || { echo "env must be staging|prod" >&2; exit 1; }
export AWS_PAGER=""
CLUSTER="sps-cluster-$ENV"

# Find the scheduled state that runs this npm script → its task def, container, netcfg.
SPEC=""
for M in nightly weekly annual; do
  ARN="$(aws stepfunctions list-state-machines --query "stateMachines[?name=='scholars-$M-$ENV'].stateMachineArn" --output text)"
  [[ -n "$ARN" && "$ARN" != None ]] || continue
  SPEC="$(aws stepfunctions describe-state-machine --state-machine-arn "$ARN" --query definition --output text \
    | SCRIPT="$SCRIPT" python3 -c '
import json, os, sys
want = os.environ["SCRIPT"]
def walk(states):
    for s in states.values():
        p = s.get("Parameters", {})
        for c in p.get("Overrides", {}).get("ContainerOverrides", []):
            if want in (c.get("Command") or []):
                nc = p["NetworkConfiguration"]["AwsvpcConfiguration"]
                return {"taskDef": p["TaskDefinition"], "container": c["Name"],
                        "net": {"awsvpcConfiguration": {"subnets": nc["Subnets"],
                                "securityGroups": nc["SecurityGroups"],
                                "assignPublicIp": nc.get("AssignPublicIp", "DISABLED")}}}
        for b in s.get("Branches", []):
            r = walk(b["States"])
            if r: return r
r = walk(json.load(sys.stdin)["States"])
print(json.dumps(r) if r else "")')"
  [[ -n "$SPEC" ]] && break
done
[[ -n "$SPEC" ]] || { echo "no scheduled state runs '$SCRIPT' in scholars-*-$ENV" >&2; exit 1; }

get() { python3 -c "import json,sys; v=json.loads(sys.argv[1])[sys.argv[2]]; print(v if isinstance(v,str) else json.dumps(v))" "$SPEC" "$1"; }
TASKDEF="$(get taskDef)"; CONTAINER="$(get container)"; NETJSON="$(get net)"
OVR="$(CONTAINER="$CONTAINER" SCRIPT="$SCRIPT" python3 -c '
import json, os, sys
env = [{"name": k, "value": v} for k, v in (a.split("=", 1) for a in sys.argv[1:])]
print(json.dumps({"containerOverrides": [{"name": os.environ["CONTAINER"],
    "command": ["npm", "run", os.environ["SCRIPT"]], "environment": env}]}))' "$@")"

echo "Launching npm run $SCRIPT ${*:+($*) }on $CLUSTER ($TASKDEF)…"
TASK_ARN="$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$TASKDEF" --launch-type FARGATE \
  --network-configuration "$NETJSON" --overrides "$OVR" --query 'tasks[0].taskArn' --output text)"
TASK_ID="${TASK_ARN##*/}"
echo "task: $TASK_ID — waiting…"
# ponytail: the ECS waiter gives up after ~10 min; retry once, then check the console.
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" || aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
EXIT="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --query 'tasks[0].containers[0].exitCode' --output text)"
echo "exit=$EXIT — log tail:"
aws logs get-log-events --log-group-name "/aws/ecs/sps-etl-$ENV" --log-stream-name "etl/$CONTAINER/$TASK_ID" --limit 40 --output json \
  | python3 -c 'import json,sys; [print(e["message"]) for e in json.load(sys.stdin)["events"]]' | grep -vE '^\s*$|npm notice' | tail -25
[[ "$EXIT" == 0 ]]
