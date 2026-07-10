#!/usr/bin/env bash
#
# sps-satcheck.sh — sequential-vs-concurrent saturation isolator.
#
# Runs K People concept searches one-at-a-time, then K at once (concurrency K),
# and compares per-query latency. If concurrent per-query latency is much worse
# than sequential, the OpenSearch *node* is the wall, not the app — this is the
# probe that proved staging's single-node capacity ceiling
# (docs/search-people-concurrency-performance.md §4). A prod-sized cluster should
# show a far smaller sequential→concurrent gap.
#
# Read-only (GET). Run from the WCM network. macOS-safe (sort -n + index).
#
# Usage:
#   scripts/perf/sps-satcheck.sh
#   K=5 HOST=https://scholars-staging.weill.cornell.edu scripts/perf/sps-satcheck.sh
#   scripts/perf/sps-satcheck.sh --selftest      # verify the math, no network
#
set -euo pipefail

HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
K="${K:-5}"
CONCEPTS=(Neoplasms HIV "Diabetes Mellitus" Inflammation Neurons "Heart Failure")

stat() {  # <p|mean> : newline numbers on stdin -> value
  if [ "$1" = "mean" ]; then
    awk '{s+=$1;n++} END{ if(n) printf "%.3f", s/n; else print "0.000" }'
  else
    sort -n | awk -v p="$1" '{a[NR]=$1} END{ if(NR==0){print "0.000";exit} r=(p/100.0)*NR; i=int(r); if(i<r)i++; if(i<1)i=1; if(i>NR)i=NR; printf "%.3f", a[i] }'
  fi
}

selftest() {
  local o
  o="$(printf '%s\n' 2 4 6 | stat mean)"; [ "$o" = "4.000" ] || { echo "FAIL mean=$o want 4.000"; exit 1; }
  o="$(printf '%s\n' 1 2 3 4 5 | stat 50)"; [ "$o" = "3.000" ] || { echo "FAIL p50=$o want 3.000"; exit 1; }
  echo "selftest OK — stat math"
}

[ "${1:-}" = "--selftest" ] && { selftest; exit 0; }
command -v jq >/dev/null || { echo "need jq"; exit 2; }

enc() { jq -rn --arg s "$1" '$s|@uri'; }
# req <concept> : print total seconds for one People search (0 on failure)
req() {
  curl -4 -s -o /dev/null -w '%{time_total}\n' \
    "$HOST/api/search?type=people&q=$(enc "$1")&_cb=$RANDOM$RANDOM" 2>/dev/null || echo 0
}
export -f req enc
export HOST

gen() { local i; for ((i=0; i<K; i++)); do printf '%s\n' "${CONCEPTS[$(( i % ${#CONCEPTS[@]} ))]}"; done; }

printf 'sps-satcheck  host=%s  K=%s\n\n' "$HOST" "$K"

seqf="$(mktemp)"
while IFS= read -r c; do req "$c" >> "$seqf"; done < <(gen)   # one at a time

conf="$(mktemp)"
gen | xargs -P "$K" -I{} bash -c 'req "$1"' _ {} > "$conf"    # all K at once

s_mean="$(stat mean <"$seqf")"; s_p50="$(stat 50 <"$seqf")"; s_max="$(stat 100 <"$seqf")"
c_mean="$(stat mean <"$conf")"; c_p50="$(stat 50 <"$conf")"; c_max="$(stat 100 <"$conf")"
ratio="$(awk -v a="$s_mean" -v b="$c_mean" 'BEGIN{ if(a>0) printf "%.1f", b/a; else print "n/a" }')"

printf '%-14s mean=%-8s p50=%-8s max=%-8s (s)\n' "sequential:" "$s_mean" "$s_p50" "$s_max"
printf '%-14s mean=%-8s p50=%-8s max=%-8s (s)\n' "concurrent×$K:" "$c_mean" "$c_p50" "$c_max"
printf '\nconcurrent/sequential mean ratio: %sx  ' "$ratio"
awk -v r="$ratio" 'BEGIN{ if (r!="n/a" && r+0 >= 2.0) print "→ node-capacity wall (concurrency, not app)"; else print "→ no single-node saturation at this K" }'
rm -f "$seqf" "$conf"
