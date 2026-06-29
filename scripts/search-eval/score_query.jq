# Score one query's combined result against an expected-scholar list.
# Args: $c (combined object from fetch_combined), $e (array of name regexes), $q (query string).
# Output: {query, meshMapped, confidence, total, expected:[{re,rank,name,pubs,matched}], summary}.
($e | map(. as $re | { re: $re, hit: ( $c.hits | map(select(.preferredName | test($re; "i")))[0] ) })) as $m
| {
    query: $q,
    meshMapped: $c.interpretation.meshMapped,
    confidence: $c.interpretation.meshConfidence,
    total: $c.interpretation.total,
    expected: ($m | map({ re, rank: .hit.rank, name: .hit.preferredName, pubs: .hit.pubCount, matched: (.hit.evidence.count) })),
    summary: {
      n: ($e | length),
      found:  ([ $m[] | select(.hit) ] | length),
      top10:  ([ $m[] | select(.hit.rank != null and .hit.rank <= 10) ] | length),
      top20:  ([ $m[] | select(.hit.rank != null and .hit.rank <= 20) ] | length),
      medianRank: ([ $m[] | select(.hit) | .hit.rank ] | sort | if length == 0 then null else .[(length/2) | floor] end),
      mrr: ( ( ([ $m[] | select(.hit) | (1 / .hit.rank) ] | add) // 0 ) / ($e | length) )
    }
  }
