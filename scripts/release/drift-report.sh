#!/usr/bin/env bash
# Drift report (#1765, #1987): deployed state vs the committed cdk snapshots.
#   1. Flags: the app task def's container env vs app-stack source
#      (flag-parity.mjs --drift). A merged flag is DARK until
#      `cdk deploy Sps-App-<env>`.
#   2. ETL: step ids in the deployed scholars-*-<env> state machines vs
#      etl-stack source (flag-parity.mjs --etl-drift). ETL steps ship only on
#      `cdk deploy Sps-Etl-<env>`.
#
# Usage (repo root, AWS creds in the environment):
#   scripts/release/drift-report.sh <staging|prod> [app-taskdef]
# With no task def, the service's current one is read via ecs describe-services.
#
# Callers:
#   deploy.yml "Drift report" step  -- informational, always exits 0. An
#     AccessDenied before the deploy role gains the states:* reads is a notice.
#   drift-check.yml (daily) with DRIFT_STRICT=1 -- exits 1 on any drift
#     (so GitHub emails), 2 when a check could not run (e.g. the read-only
#     role is missing a grant, or flag-parity rejected its input).
#
# flag-parity exit codes: 0 OK, 1 drift, 2 input/usage error (could not run).
# Writes ::notice::/::warning::/::error:: annotations and, when
# $GITHUB_STEP_SUMMARY is set, a markdown section.
set -euo pipefail

env_name="${1:?usage: drift-report.sh <staging|prod> [app-taskdef]}"
taskdef="${2:-}"
strict="${DRIFT_STRICT:-0}"
summary_file="${GITHUB_STEP_SUMMARY:-/dev/null}"
drift_level=warning
[ "$strict" = 1 ] && drift_level=error
err=$(mktemp)
trap 'rm -f "$err"' EXIT
drift=0
norun=0

summary() { printf '%s\n' "$1" >> "$summary_file"; }

# A check whose AWS read failed. $1 label, $2 the failing action.
cannot_run() {
  norun=1
  if [ "$strict" != 1 ] && grep -q AccessDenied "$err"; then
    echo "::notice::$1 drift check skipped ($env_name): AccessDenied on $2 -- the deploy role gains it with the next 'cdk deploy Sps-App-$env_name' (#1987)."
    summary "- $1: skipped (AccessDenied on $2)"
  else
    cat "$err" >&2
    echo "::$drift_level::$1 drift check could not run ($env_name): $2 failed."
    summary "- $1: could not run ($2 failed, see log)"
  fi
}

# $1 label, $2 flag-parity mode, $3 JSON for stdin, $4 stack to deploy on drift.
run_check() {
  local out rc=0
  out=$(printf '%s' "$3" | node scripts/release/flag-parity.mjs "$2" "$env_name" - 2>&1) || rc=$?
  echo "$out"
  case "$rc" in
    0)
      summary "- $1: OK"
      ;;
    1)
      drift=1
      echo "::$drift_level::$1 DRIFT ($env_name) -- run 'cdk diff $4-$env_name' then 'cdk deploy $4-$env_name' from master."
      summary "- $1: **DRIFT** -- run \`cdk deploy $4-$env_name\` from master."
      ;;
    *)
      norun=1
      echo "::$drift_level::$1 drift check could not run ($env_name): flag-parity exited $rc (input/usage error, not drift)."
      summary "- $1: could not run (flag-parity exited $rc, see log)"
      ;;
  esac
  summary "$(printf '\n```\n%s\n```\n' "$out")"
}

summary "### Drift report ($env_name)"

# --- 1. flags ---
if [ -z "$taskdef" ]; then
  if ! taskdef=$(aws ecs describe-services --cluster "sps-cluster-$env_name" \
        --services "sps-app-$env_name" --query 'services[0].taskDefinition' \
        --output text 2>"$err"); then
    cannot_run "Flags" "ecs:DescribeServices"
    taskdef=""
  elif [ -z "$taskdef" ] || [ "$taskdef" = "None" ]; then
    echo "service sps-app-$env_name not found in sps-cluster-$env_name" > "$err"
    cannot_run "Flags" "ecs:DescribeServices"
    taskdef=""
  fi
fi
if [ -n "$taskdef" ]; then
  if td_json=$(aws ecs describe-task-definition --task-definition "$taskdef" 2>"$err"); then
    echo "app task def: $taskdef"
    run_check "Flags" --drift "$td_json" "Sps-App"
  else
    cannot_run "Flags" "ecs:DescribeTaskDefinition"
  fi
fi

# --- 2. ETL definitions ---
if ! arns=$(aws stepfunctions list-state-machines \
      --query "stateMachines[?starts_with(name,'scholars-') && ends_with(name,'-$env_name')].stateMachineArn" \
      --output text 2>"$err"); then
  cannot_run "ETL" "states:ListStateMachines"
elif ! machines=$(for arn in $arns; do
        [ "$arn" = "None" ] && continue
        aws stepfunctions describe-state-machine --state-machine-arn "$arn" \
          --query '{name:name,definition:definition}' --output json 2>"$err" || exit 1
      done | jq -s .); then
  cannot_run "ETL" "states:DescribeStateMachine"
else
  # Zero machines reaches flag-parity as `[]`, which it rejects with exit 2.
  run_check "ETL" --etl-drift "$machines" "Sps-Etl"
fi

if [ "$strict" = 1 ]; then
  if [ "$drift" = 1 ]; then exit 1; fi
  if [ "$norun" = 1 ]; then exit 2; fi
fi
exit 0
