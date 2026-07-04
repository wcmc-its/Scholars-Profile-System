#!/usr/bin/env bash
# What ships today — pre-deploy drift report for Sps-App-<env>.
#
# Answers, before you run `cdk deploy Sps-App-<env>` or roll the image:
#   1. which git sha the env is actually running, and every commit an image
#      roll would ship (prod lags master by hundreds of commits — a deploy is
#      never scoped to "your" change);
#   2. every flag/env-var that would CHANGE on a cdk deploy (live task-def vs
#      what master synthesizes for this env);
#   3. pending Prisma migrations and cdk/ infra drift shipping alongside.
#
# Usage: scripts/release/whats-shipping.sh [prod|staging]   (default prod)
# Needs: aws cli (creds in env), jq, git fetch access, repo root as cwd.
set -euo pipefail

ENV="${1:-prod}"
[[ "$ENV" == "prod" || "$ENV" == "staging" ]] || { echo "usage: $0 [prod|staging]" >&2; exit 2; }
CLUSTER="sps-cluster-$ENV" SERVICE="sps-app-$ENV" REPO="scholars-app-$ENV"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "=== What ships today: Sps-App-$ENV ($(date '+%Y-%m-%d %H:%M %Z')) ==="

# --- 1. deployed image: RUNNING task digest -> ECR git-sha tag ---
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
  --desired-status RUNNING --query 'taskArns[0]' --output text)
DIGEST=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].containers[?name==`app`]|[0].imageDigest' --output text)
SHA=$(aws ecr describe-images --repository-name "$REPO" --image-ids imageDigest="$DIGEST" \
  --query 'imageDetails[0].imageTags' --output json | jq -r '.[]|select(test("^[0-9a-f]{40}$"))' | head -1)
PUSHED=$(aws ecr describe-images --repository-name "$REPO" --image-ids imageDigest="$DIGEST" \
  --query 'imageDetails[0].imagePushedAt' --output text)

git fetch -q origin master
if [[ -z "$SHA" ]]; then
  echo "!! running image digest $DIGEST has no git-sha tag in ECR — cannot compute drift" >&2
  exit 1
fi
echo "running image: ${SHA:0:12} (pushed $PUSHED, digest ${DIGEST:7:19}…)"
if ! git merge-base --is-ancestor "$SHA" origin/master 2>/dev/null; then
  echo "!! deployed sha is NOT an ancestor of origin/master — image built off-branch?" >&2
fi

# --- 2. commit drift an image roll ships ---
COUNT=$(git rev-list --count "$SHA"..origin/master)
echo
echo "--- image roll would ship $COUNT commit(s) ($SHA..origin/master) ---"
git log --oneline "$SHA"..origin/master | sed 's/^/  /'

# --- 3. migrations + infra drift ---
echo
echo "--- new Prisma migrations in that range ---"
git diff --name-only "$SHA"..origin/master -- prisma/migrations 2>/dev/null \
  | cut -d/ -f2 | sort -u | sed 's/^/  /' || true
echo
echo "--- cdk/ files changed in that range (a cdk deploy ships ALL of this; run cdk diff before deploying) ---"
git diff --stat "$SHA"..origin/master -- cdk/lib cdk/bin 2>/dev/null | sed 's/^/  /' || true

# --- 4. flag delta: live task-def env vs master-synthesized env ---
TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$TD" \
  --query 'taskDefinition.containerDefinitions[?name==`app`]|[0].environment' \
  --output json | jq 'map({(.name): .value}) | add' > "$TMP/live.json"
node scripts/release/flag-parity.mjs --dump "$ENV" > "$TMP/synth.json"
echo
echo "--- env vars that CHANGE on the next cdk deploy Sps-App-$ENV (live -> master) ---"
jq -rn --slurpfile live "$TMP/live.json" --slurpfile synth "$TMP/synth.json" '
  ($live[0]) as $l | ($synth[0]) as $s |
  ([$l, $s | keys[]] | unique) as $keys |
  $keys[] | select($l[.] != $s[.]) |
  "  \(.): \($l[.] // "«unset»") -> \($s[.] // "«removed»")"' \
  | grep -v '^  OTEL_SERVICE_NAME\|^  SPS_ENV' || echo "  (none — task-def env matches master)"
echo
echo "task def: $TD"
echo "Done. This report covers the APP stack only; other stacks (Data/Etl/Edge/Network) have their own drift."
