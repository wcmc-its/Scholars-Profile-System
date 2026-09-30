#!/usr/bin/env bash
# Print the image digest (sha256:...) the sps-app-<env> service is RUNNING,
# for `cdk deploy Sps-App-<env> -c appImageDigest=...` (#2343).
#
# Without it, a manual cdk deploy re-registers sps-app-<env> / sps-migrate-<env>
# on mutable `:latest` and discards the pipeline's digest pin (#2121). With it,
# the CDK-registered revision stays pinned to exactly the image already serving
# traffic, so a flag-only deploy changes env, never the image.
#
# Source of truth, in order:
#   1. the service's primary task definition, when its app image is
#      `<repo>@sha256:...` (every deploy.yml-registered revision is);
#   2. otherwise (an unpinned revision is live -- the #2343 state), the
#      imageDigest ECS recorded on the RUNNING app containers, only if every
#      running task agrees. Never ECR `:latest`: that is what the service
#      would pull next, not what it runs.
# Refuses (exit 1) rather than guess when neither yields one digest.
#
# Usage: scripts/release/running-app-digest.sh <prod|staging>
# Needs: aws cli (creds in env). Read-only: ecs describe-services,
# describe-task-definition, list-tasks, describe-tasks.
set -euo pipefail
export AWS_PAGER=""

ENV="${1:-}"
[[ "$ENV" == "prod" || "$ENV" == "staging" ]] || { echo "usage: $0 <prod|staging>" >&2; exit 2; }
CLUSTER="sps-cluster-$ENV" SERVICE="sps-app-$ENV"
DIGEST_RE='^sha256:[0-9a-f]{64}$'

TASKDEF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)
[[ -n "$TASKDEF" && "$TASKDEF" != "None" ]] || { echo "!! $SERVICE not found in $CLUSTER" >&2; exit 1; }

IMAGE=$(aws ecs describe-task-definition --task-definition "$TASKDEF" \
  --query "taskDefinition.containerDefinitions[?name=='app']|[0].image" --output text)

if [[ "$IMAGE" == *@sha256:* ]]; then
  DIGEST="${IMAGE##*@}"
  echo "running-app-digest: $SERVICE on ${TASKDEF##*/} is pinned" >&2
else
  echo "running-app-digest: ${TASKDEF##*/} is UNPINNED ($IMAGE); reading running tasks" >&2
  TASKS=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
    --desired-status RUNNING --query 'taskArns' --output text)
  [[ -n "$TASKS" && "$TASKS" != "None" ]] || { echo "!! no RUNNING tasks on $SERVICE" >&2; exit 1; }
  # shellcheck disable=SC2086 # TASKS is a whitespace-separated ARN list
  DIGESTS=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks $TASKS \
    --query "tasks[].containers[?name=='app'].imageDigest[]" --output text | tr '\t' '\n' | sort -u)
  if [[ $(printf '%s\n' "$DIGESTS" | grep -c .) -ne 1 ]]; then
    echo "!! running tasks disagree on the app digest (rollout in progress?):" >&2
    printf '%s\n' "$DIGESTS" >&2
    exit 1
  fi
  DIGEST="$DIGESTS"
fi

[[ "$DIGEST" =~ $DIGEST_RE ]] || { echo "!! not a sha256 digest: '$DIGEST'" >&2; exit 1; }
echo "$DIGEST"
