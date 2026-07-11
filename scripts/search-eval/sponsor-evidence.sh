#!/usr/bin/env bash
# Assemble a per-candidate EVIDENCE BUNDLE for the sponsor-match gold grader.
# The bundle is what an evidence-grounded judge reasons over — REAL, retrieved
# substance, deliberately INDEPENDENT of the MeSH tagged-counts Scholars ranks on
# (so grading is not circular). Signals:
#   • Scholars profile overview (human-authored bio: role, program leadership, focus)
#   • Scholars primaryTitle / department            (role)
#   • pool fields: humanizedAreas, pubCount, grantCount   (topical profile, fundability)
#   • OpenAlex: total citations, OpenAlex's OWN topic classification, and the
#     top-cited work TITLES on the sponsor topic   (impact + substance, external)
#     + a disambiguation flag (same-name entity count, institution match)
#
#   ./sponsor-evidence.sh "<openalex topic search>" <pool.json> > bundles.json
#   e.g. ./sponsor-evidence.sh "scleroderma" /tmp/pool-rarity-scleroderma.json
#
# Emits a JSON array of bundles. Feed to the judge (a separate step).
set -euo pipefail
HOST="${HOST:-https://scholars-staging.weill.cornell.edu}"
OA="https://api.openalex.org"
# OpenAlex "polite pool" contact — set OPENALEX_MAILTO to your email for higher rate limits.
# (Optional; bare requests use the common pool. OpenAlex rejects unknown query params.)
MAILTO="${OPENALEX_MAILTO:-}"
# WCM-orbit institutions to prefer when disambiguating an OpenAlex author by name.
INST_RE='Weill Cornell|Cornell|Hospital for Special Surgery|Memorial Sloan|Sloan Kettering|NewYork-Presbyterian|New York Presbyterian|Rockefeller'
topic="${1:?usage: ./sponsor-evidence.sh \"<topic>\" <pool.json>}"
pool="${2:?need pool.json}"
enc_topic="$(jq -rn --arg s "$topic" '$s|@uri')"

# strip html + collapse whitespace + truncate
clean() { jq -rn --arg s "$1" '$s | gsub("<[^>]+>";" ") | gsub("\\s+";" ") | .[0:320]'; }

bundles="[]"
while read -r row; do
  cwid="$(jq -r '.cwid' <<<"$row")"
  name="$(jq -r '.preferredName // .name // ""' <<<"$row")"
  [[ -z "$name" ]] && continue

  # --- Scholars profile: role + human bio overview ---
  prof="$(curl -4 -s --max-time 20 "$HOST/api/scholars/$cwid" || echo '{}')"
  title="$(jq -r '.primaryTitle // "?"' <<<"$prof")"
  dept="$(jq -r '.primaryDepartment // "?"' <<<"$prof")"
  overview="$(clean "$(jq -r '.overview // ""' <<<"$prof")")"

  # --- OpenAlex: disambiguate by name (+institution), then impact + topical works ---
  authors="$(curl -4 -s --max-time 20 "$OA/authors?search=$(jq -rn --arg s "$name" '$s|@uri')&per_page=5${MAILTO:+&mailto=$MAILTO}" || echo '{}')"
  n_same="$(jq '[.results[]?] | length' <<<"$authors")"
  aid="$(jq -r --arg re "$INST_RE" '
      ([.results[]? | select((([.last_known_institutions[]?.display_name] + [.affiliations[]?.institution.display_name]) | join(" ")) | test($re))]
       | sort_by(-.works_count) | .[0].id)
      // (.results[0].id // "") | sub("https://openalex.org/";"")' <<<"$authors")"
  inst_matched="$(jq -r --arg re "$INST_RE" '([.results[]? | select((([.last_known_institutions[]?.display_name] + [.affiliations[]?.institution.display_name])|join(" "))|test($re))]|length) > 0' <<<"$authors")"
  cites=0; oa_topics="[]"; topical="[]"; n_topical=0
  if [[ -n "$aid" ]]; then
    ainfo="$(curl -4 -s --max-time 20 "$OA/authors/$aid${MAILTO:+?mailto=$MAILTO}" || echo '{}')"
    cites="$(jq -r '.cited_by_count // 0' <<<"$ainfo")"
    oa_topics="$(jq -c '[.topics[:4][]?.display_name]' <<<"$ainfo")"
    works="$(curl -4 -s --max-time 20 "$OA/works?filter=author.id:$aid,default.search:$enc_topic&sort=cited_by_count:desc&per_page=3${MAILTO:+&mailto=$MAILTO}" || echo '{}')"
    n_topical="$(jq -r '.meta.count // 0' <<<"$works")"
    topical="$(jq -c '[.results[]? | {c: .cited_by_count, t: (.title // "")|.[0:90]}]' <<<"$works")"
  fi

  # MeSH tagged-count from the pool row (the topic search's evidenceLines) — ONE signal,
  # NOT the grade; lets the judge catch OpenAlex name-collisions (e.g. a sparse profile
  # whose MeSH volume proves topical expertise the OA match missed).
  mesh="$(jq -c '([.evidenceLines[]? | select(.kind=="publications")] | max_by(.count)) as $e
                 | { count: ($e.count // 0), term: ($e.term // null),
                     focusPct: (if (.pubCount // 0)>0 and $e then (($e.count/.pubCount*100)|floor) else 0 end) }' <<<"$row")"

  b="$(jq -n --arg cwid "$cwid" --arg name "$name" --arg title "$title" --arg dept "$dept" \
        --arg overview "$overview" \
        --argjson areas "$(jq -c '[.humanizedAreas.labels[:6][]?] // []' <<<"$row")" \
        --argjson pub "$(jq '.pubCount // 0' <<<"$row")" \
        --argjson grant "$(jq '.grantCount // 0' <<<"$row")" \
        --argjson mesh "$mesh" \
        --argjson cites "${cites:-0}" --argjson oa_topics "$oa_topics" \
        --argjson n_topical "${n_topical:-0}" --argjson topical "$topical" \
        --argjson n_same "${n_same:-0}" --arg inst_matched "$inst_matched" '
      { cwid: $cwid, name: $name, title: $title, dept: $dept, overview: $overview,
        areas: $areas, pubCount: $pub, grantCount: $grant,
        meshTagged: $mesh,
        openalex: { citations: $cites, topics: $oa_topics,
                    topicalWorkCount: $n_topical, topTopicalWorks: $topical,
                    sameNameCount: $n_same, institutionMatched: ($inst_matched=="true") } }')"
  bundles="$(jq -n --argjson a "$bundles" --argjson b "$b" '$a + [$b]')"
done < <(jq -c '.hits[]' "$pool")

echo "$bundles"
