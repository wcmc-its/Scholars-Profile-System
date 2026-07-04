# Score one query's combined result against an expected-scholar list.
# Input (stdin): $c, the combined object from fetch_combined (piped, not argv — it can be
#   multi-MB and would blow ARG_MAX as --argjson). Args: $e (expected list), $q (query string).
# Expected entries are either a bare regex string (legacy) or {re, cwid, arch}. When cwid is
#   present we match the hit by cwid (robust to namesakes, e.g. "Igel" vs "Nigel"); otherwise
#   we fall back to the case-insensitive regex against preferredName.
# Output: {query, meshMapped, confidence, total, expected:[{re,cwid,arch,rank,name,pubs,matched}], summary}.
. as $c
| ($e | map(if type == "string" then { re: ., cwid: null, arch: null } else . end)) as $exp
| ($exp | map(. as $x | {
      re: $x.re, cwid: $x.cwid, arch: $x.arch,
      hit: ( $c.hits | map(select(
               (($x.cwid // null) != null and .cwid == $x.cwid)
               or (($x.cwid // null) == null and (.preferredName | test($x.re; "i")))
             ))[0] )
    })) as $m
| {
    query: $q,
    meshMapped: $c.interpretation.meshMapped,
    confidence: $c.interpretation.meshConfidence,
    total: $c.interpretation.total,
    expected: ($m | map({ re, cwid, arch, rank: .hit.rank, name: .hit.preferredName, pubs: .hit.pubCount, matched: (.hit.evidence.count) })),
    summary: {
      n: ($exp | length),
      found:  ([ $m[] | select(.hit) ] | length),
      top10:  ([ $m[] | select(.hit.rank != null and .hit.rank <= 10) ] | length),
      top20:  ([ $m[] | select(.hit.rank != null and .hit.rank <= 20) ] | length),
      medianRank: ([ $m[] | select(.hit) | .hit.rank ] | sort | if length == 0 then null else .[(length/2) | floor] end),
      mrr: ( ( ([ $m[] | select(.hit) | (1 / .hit.rank) ] | add) // 0 ) / ($exp | length) )
    }
  }
