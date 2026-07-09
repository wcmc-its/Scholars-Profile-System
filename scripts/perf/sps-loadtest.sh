#!/usr/bin/env bash
#
# sps-loadtest.sh — /search People concept-search concurrency ramp.
#
# Fires a C-ramp of People concept searches at a deployed env and reports, per
# concurrency level: ttfb and total-time p50/p90/max, plus the non-200 count.
# Rotates broad MeSH concepts per request so the response cache can't absorb the
# load — OpenSearch is actually exercised. This is the tool behind the C-ramp
# numbers in docs/search-people-concurrency-performance.md §3.
#
# Targets the JSON API the People tab calls (same endpoint as
# scripts/search-eval/lib.sh):
#   GET $HOST/api/search?type=people&q=<concept>&_cb=<rand>
# Point PATH_TMPL at the streamed page ("/search?q=%s&_cb=%s") if you want
# page-render ttfb instead of the API number.
#
# Read-only (GET). Run from the WCM network — the staging search API is WCM-gated.
# macOS-safe: percentiles via `sort -n` + index (no gawk `asort`); no `zcat`.
#
# Usage:
#   scripts/perf/sps-loadtest.sh [label]
#   HOST=https://scholars.weill.cornell.edu scripts/perf/sps-loadtest.sh prod
#   LEVELS="1 5 8 10" REPS=4 scripts/perf/sps-loadtest.sh
#   scripts/perf/sps-loadtest.sh --selftest      # verify percentile math, no network
#
set -euo pipefail

HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
LEVELS="${LEVELS:-1 5 8 10}"
REPS="${REPS:-4}"                       # per-level N = max(level * REPS, 12)
PATH_TMPL="${PATH_TMPL:-/api/search?type=people&q=%s&_cb=%s}"
# broad MeSH concepts — rotated so the response cache can't serve a repeat.
# ponytail: hard-coded broad set; extend if a concept stops being broad.
CONCEPTS=(Neoplasms HIV "Diabetes Mellitus" Inflammation Neurons Antibodies "Heart Failure" Immunotherapy)

# pct <p> : read newline-separated numbers on stdin, print the p-th percentile.
# "sort -n + index" — deliberately not gawk asort (unavailable on macOS awk).
pct() {
  sort -n | awk -v p="$1" '
    { a[NR]=$1 }
    END { if (NR==0) { print "0.000"; exit }
          r=(p/100.0)*NR; i=int(r); if (i<r) i++;   # nearest-rank (ceil)
          if (i<1) i=1; if (i>NR) i=NR;
          printf "%.3f", a[i] }'
}

selftest() {
  local o
  o="$(printf '%s\n' 1 2 3 4 5 6 7 8 9 10 | pct 50)";  [ "$o" = "5.000" ]  || { echo "FAIL p50=$o want 5.000";  exit 1; }
  o="$(printf '%s\n' 1 2 3 4 5 6 7 8 9 10 | pct 90)";  [ "$o" = "9.000" ]  || { echo "FAIL p90=$o want 9.000";  exit 1; }
  o="$(printf '%s\n' 1 2 3 4 5 6 7 8 9 10 | pct 100)"; [ "$o" = "10.000" ] || { echo "FAIL p100=$o want 10.000"; exit 1; }
  o="$(printf '%s\n' 7 | pct 50)";                     [ "$o" = "7.000" ]  || { echo "FAIL single=$o want 7.000"; exit 1; }
  o="$(printf '' | pct 50)";                           [ "$o" = "0.000" ]  || { echo "FAIL empty=$o want 0.000";  exit 1; }
  echo "selftest OK — percentile math"
}

[ "${1:-}" = "--selftest" ] && { selftest; exit 0; }
command -v jq  >/dev/null || { echo "need jq";  exit 2; }

label="${1:-loadtest}"
enc() { jq -rn --arg s "$1" '$s|@uri'; }

# one <concept> : print "code ttfb total" for a single request (000 0 0 on curl failure)
one() {
  local c="$1" url
  # shellcheck disable=SC2059  # PATH_TMPL is an intentional format string
  url="$HOST$(printf "$PATH_TMPL" "$(enc "$c")" "$RANDOM$RANDOM")"
  curl -4 -s -o /dev/null -w '%{http_code} %{time_starttransfer} %{time_total}\n' "$url" 2>/dev/null || echo "000 0 0"
}
export -f one enc
export HOST PATH_TMPL

# emit N rotated concepts, one per line
gen() { local n="$1" i; for ((i=0; i<n; i++)); do printf '%s\n' "${CONCEPTS[$(( i % ${#CONCEPTS[@]} ))]}"; done; }

printf 'sps-loadtest [%s]  host=%s  levels="%s"\n' "$label" "$HOST" "$LEVELS"
printf '%-6s %-4s | %-27s | %-27s | %s\n' "C" "N" "ttfb p50/p90/max (s)" "total p50/p90/max (s)" "non-200"
printf -- '------------------------------------------------------------------------------------------\n'
for C in $LEVELS; do
  N=$(( C * REPS )); [ "$N" -lt 12 ] && N=12
  res="$(mktemp)"
  gen "$N" | xargs -P "$C" -I{} bash -c 'one "$1"' _ {} > "$res"
  ttfb="$(cut -d' ' -f2 "$res")"; tot="$(cut -d' ' -f3 "$res")"
  bad="$(awk '$1!="200"{n++} END{print n+0}' "$res")"
  printf '%-6s %-4s | %7s / %-7s / %-7s | %7s / %-7s / %-7s | %s\n' \
    "$C" "$N" \
    "$(pct 50 <<<"$ttfb")" "$(pct 90 <<<"$ttfb")" "$(pct 100 <<<"$ttfb")" \
    "$(pct 50 <<<"$tot")"  "$(pct 90 <<<"$tot")"  "$(pct 100 <<<"$tot")" \
    "$bad/$N"
  rm -f "$res"
done
