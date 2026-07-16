#!/usr/bin/env bash
# Capture FULL sponsor-match responses from a deployed env — one raw JSON per fixture.
#
# Why this exists when `sponsor-eval.sh --fetch` already fetches: --fetch keeps only the ranked
# cwid list (`:105`). The offline A/B (sponsor-rerank-ab.ts) RE-DERIVES the ranking from
# `concepts[]` + `contributions[]` + `mostRecentYear`, so it needs the whole payload.
#
# One capture feeds BOTH arms of the recency A/B. That is the point: the arms then share one
# LLM concept extraction, so the extractor's ~0.0074 nDCG noise cancels WITHIN each pair instead
# of having to be cleared by repeated sampling. It also dodges a hazard the flag-flip A/B cannot:
# the route's cache key is `sponsor:${engine}:${inputHash}` (route.ts:140) and does NOT include
# SPONSOR_MATCH_RECENCY, so flipping the flag can serve a stale pre-flip payload.
#
#   SPONSOR_COOKIE_FILE=~/.sps-sponsor-cookie DRAW=1 ./sponsor-capture.sh
#   HOST=https://scholars-staging.weill.cornell.edu DRAW=2 ./sponsor-capture.sh   # a 2nd draw
#
# DRAW is only a directory label. Two draws taken <30 min apart are NOT independent — the route
# serves cached payloads (TTL 5 min, stale-while-revalidate to 30 min), so a fast second sweep
# re-measures the same extraction. Leave >30 min between draws that are meant to be independent.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh" # HOST

FIX="${FIX:-$DIR/sponsor-fixtures.json}"
DRAW="${DRAW:-1}"
OUT="${OUT:-$DIR/captures/draw-$DRAW}"
RETRIES="${RETRIES:-4}"

[[ -f "$FIX" ]] || {
  echo "no fixtures at $FIX" >&2
  exit 1
}

# The route is auth-gated (/edit, developer-only; route.ts:214-222). Read the cookie from a FILE,
# never an inline arg — an inline secret lands in shell history and in `ps` for every local user.
# Its value is never echoed here; only pass/fail is reported.
COOKIE_FILE="${SPONSOR_COOKIE_FILE:-$HOME/.sps-sponsor-cookie}"
if [[ -z "${SPONSOR_COOKIE:-}" && -r "$COOKIE_FILE" ]]; then SPONSOR_COOKIE="$(<"$COOKIE_FILE")"; fi
SPONSOR_COOKIE="${SPONSOR_COOKIE//[$'\r\n']/}"
[[ -n "${SPONSOR_COOKIE//[[:space:]]/}" ]] || {
  echo "no session cookie." >&2
  echo "  Sign in to $HOST as a developer/superuser, copy the __Secure-sps_session cookie, then:" >&2
  echo "    umask 077; printf '__Secure-sps_session=%s' '<value>' > $COOKIE_FILE" >&2
  exit 1
}

mkdir -p "$OUT"
echo "sponsor-capture @ ${HOST}  draw=${DRAW}  →  ${OUT}"

n_ok=0 n_bad=0
while IFS= read -r prompt; do
  id="$(jq -r '.id' <<<"$prompt")"
  paste="$(jq -r '.paste' <<<"$prompt")"

  code="" body=""
  for ((attempt = 1; attempt <= RETRIES; attempt++)); do
    # /api/edit/* enforces a same-origin guard (lib/edit/authz.ts verifyRequestOrigin): a browser
    # sets sec-fetch-site/origin, curl must send them explicitly or the route 403s. `engine` is
    # omitted deliberately — `useSpine = engine !== "bespoke"` makes undefined mean the spine,
    # which is the prod path and the only one that carries recency.
    resp="$(curl -4 -s -w $'\n%{http_code}' --max-time 300 -X POST "$HOST/api/edit/sponsor-match" \
      -H 'content-type: application/json' \
      -H 'sec-fetch-site: same-origin' \
      -H "origin: $HOST" \
      -H "cookie: $SPONSOR_COOKIE" \
      --data "$(jq -n --arg d "$paste" '{description:$d}')")"
    code="${resp##*$'\n'}"
    body="${resp%$'\n'*}"
    [[ "$code" == "200" ]] && break
    # 401/403 are terminal (stale cookie / CSRF) — retrying cannot help. 5xx is the OpenSearch
    # parent breaker: transient, and a fixture that 502s is a MEASUREMENT FAILURE, not a zero.
    if [[ "$code" == "401" || "$code" == "403" ]]; then
      echo "  ✗ $id — HTTP $code (401=cookie missing/stale, 403=forbidden/CSRF). TERMINAL." >&2
      exit 1
    fi
    echo "  ⚠ $id — HTTP $code (attempt $attempt/$RETRIES); backing off" >&2
    sleep $((attempt * 8))
  done

  if [[ "$code" != "200" ]] || ! jq -e . >/dev/null 2>&1 <<<"$body"; then
    echo "  ✗ $id — UNMEASURED (HTTP $code). Not written; the A/B will skip it, not score it 0." >&2
    n_bad=$((n_bad + 1))
    continue
  fi

  # A payload cached BEFORE the flag flip carries no `mostRecentYear`, and recencyWeight() then
  # returns 1 for every mode (contract.ts:200) — both arms would collapse to the same order and
  # the A/B would report a perfect, meaningless null result. Refuse to write a dead payload.
  years="$(jq '[.candidates[]? | select(.mostRecentYear != null)] | length' <<<"$body")"
  cands="$(jq '.candidates | length' <<<"$body")"
  if [[ "$years" == "0" ]]; then
    echo "  ✗ $id — $cands candidates, ZERO carry mostRecentYear. Either SPONSOR_MATCH_RECENCY is" >&2
    echo "      off on $HOST, or this is a pre-flip cached payload. Not a no-op result — a dead capture." >&2
    n_bad=$((n_bad + 1))
    continue
  fi

  jq -c . <<<"$body" >"$OUT/$id.json"
  echo "  ✓ $id   candidates=$cands  with-year=$years  concepts=$(jq '.concepts | length' <<<"$body")"
  n_ok=$((n_ok + 1))
done < <(jq -c '.prompts[] | {id, paste}' "$FIX")

echo "captured $n_ok ok, $n_bad unmeasured → $OUT"
[[ "$n_ok" -gt 0 ]] || exit 1
