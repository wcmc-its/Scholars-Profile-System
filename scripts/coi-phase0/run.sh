#!/usr/bin/env bash
# Track A — Phase 0 precision harness runner.
# Reads the 2022 reference corpus, writes intermediates + outputs to OUT_DIR (/tmp).
# Nothing confidential is written inside the repo.
set -euo pipefail

REF_DIR="${1:-$HOME/Dropbox/Index/Conflicts of Interest : External Relationships}"
OUT_DIR="${2:-/tmp/coi-phase0}"

here="$(cd "$(dirname "$0")" && pwd)"
echo ">> prep (python3 + openpyxl)"
python3 "$here/prep.py" "$REF_DIR" "$OUT_DIR"
echo
echo ">> analyze (node, dependency-free)"
node "$here/analyze.mjs" "$OUT_DIR"
echo
echo ">> done. Outputs in: $OUT_DIR"
echo "   - candidates.csv  (label the LABEL column: TRUE / co-author / funder / employer / entity-variant / family / ended / ambiguous)"
echo "   - report.md"
