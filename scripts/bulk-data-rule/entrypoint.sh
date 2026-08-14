#!/bin/bash
# scripts/bulk-data-rule/ pipeline entrypoint (containerization design, 2026-08-14).
#
# DB-write path only, in run order (README's own "Pipeline (run order)" table, steps 1/2/5/6):
#   extract_databanks -> scan2 -> preprint_extend -> attribute (WRITE_DATASET_DEPOSIT=1)
# PILOT_DEPARTMENT/WRITE_DATASET_DEPOSIT come from the Dockerfile's ENV, not set here.
#
# Then: provenance sync (design decision #1) — aws s3 syncs the whole working dir (every
# intermediate CSV) plus a run-manifest (image digest, git SHA, row count, timestamp) to
# curationBackupBucket's bulk-data-rule/<timestamp>/ prefix. This is the audit trail for what a
# run wrote, not a deliverable channel — .xlsx generation stays analyst-local (design doc).
set -eu

OUT="$HOME/Dropbox/Projects/Bulk Data Rule/data"
mkdir -p "$OUT"

echo "=== bulk-data-rule run starting: PILOT_DEPARTMENT=$PILOT_DEPARTMENT git_sha=$GIT_SHA ==="

python3 extract_databanks.py
python3 scan2.py
python3 preprint_extend.py
python3 attribute.py

TS="$(date -u +%Y%m%dT%H%M%SZ)"
# ECS task metadata endpoint (present on every Fargate task) — the running image's actual pulled
# digest, not just the mutable :latest tag it was launched from.
IMAGE_DIGEST="unknown"
if [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
  IMAGE_DIGEST="$(curl -s "$ECS_CONTAINER_METADATA_URI_V4" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ImageID","unknown"))' \
    2>/dev/null || echo unknown)"
fi
# attributed_deposits.csv always has a header row; -1 so this counts deposit rows, not lines.
ROW_COUNT=0
if [ -f "$OUT/attributed_deposits.csv" ]; then
  ROW_COUNT=$(( $(wc -l < "$OUT/attributed_deposits.csv") - 1 ))
fi

cat > "$OUT/run-manifest.json" <<MANIFEST
{
  "timestamp": "$TS",
  "git_sha": "$GIT_SHA",
  "image_digest": "$IMAGE_DIGEST",
  "pilot_department": "$PILOT_DEPARTMENT",
  "attributed_deposit_rows": $ROW_COUNT
}
MANIFEST

aws s3 sync "$OUT" "s3://${CURATION_BACKUP_BUCKET}/${CURATION_BACKUP_PREFIX}/${TS}/"
echo "=== run complete, synced to s3://${CURATION_BACKUP_BUCKET}/${CURATION_BACKUP_PREFIX}/${TS}/ ==="
