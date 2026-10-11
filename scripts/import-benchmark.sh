#!/usr/bin/env bash
# Copy research-area benchmark snapshots from a ReciterAI checkout into
# data/benchmark/ (see docs/research-areas-benchmark-refresh.md).
#
#   scripts/import-benchmark.sh ~/Dropbox/GitHub/ReciterAI
#
# Copies every snapshot listed in ReciterAI's outputs/benchmark-index.json plus
# the index itself. Snapshots are immutable once committed: a dated file that
# already exists here with different content is an error (ship a correction as
# a new snapshot date instead).
set -euo pipefail

src="${1:?usage: $0 <path to ReciterAI checkout>}/docs/benchmark/outputs"
dst="$(cd "$(dirname "$0")/.." && pwd)/data/benchmark"
[ -f "$src/benchmark-index.json" ] || { echo "no benchmark-index.json in $src" >&2; exit 1; }

for f in $(python3 -c 'import json,sys; [print(e["file"]) for e in json.load(open(sys.argv[1]))["snapshots"]]' "$src/benchmark-index.json"); do
  if [ -f "$dst/$f" ]; then
    cmp -s "$src/$f" "$dst/$f" || { echo "$f already imported and differs; snapshots are immutable" >&2; exit 1; }
  else
    cp "$src/$f" "$dst/$f"
    echo "added $f"
  fi
done
cp "$src/benchmark-index.json" "$dst/index.json"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1]))["spot_check"]; sys.exit(0 if s["rate"] is not None else "latest snapshot has no completed spot check (R3)")' \
  "$dst/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["snapshots"][0]["file"])' "$dst/index.json")"
echo "index.json updated"
