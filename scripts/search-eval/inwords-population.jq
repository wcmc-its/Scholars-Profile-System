# MATCHA_GLOSS_INWORDS — the §1 acceptance measurement, for the MeSH-descendant design
# (docs/2026-07-24-matcha-inwords-descendants-redesign-spec.md). Reads a spine-eval-run.ts artifact
# ($arm.raw.json) whose `.evidence[fixture][].blocks[]` carries {term, glossTerms, pmid, titleHtml}
# from the real `fetchKeyPaper` call.
#
# Per (fixture, concept term):
#   pool        = (candidate, concept) blocks measured
#   marked      = blocks whose key paper came back with ANY <mark>
#   glossMarked = blocks where a mark contains one of the GLOSS's own words — the line's real
#                 population (a mark from the concept/query clause is not "in their words")
#   leadMarked  = of those, the ones on the pub the card FACE shows (`papers[0]`); the rest are
#                 behind "+N more pubs". `rate` is the face rate — the honest ship number.
#   reachRate   = glossMarked / pool — the one-click-reachable rate, always ≥ rate.
#   pmids       = source papers, for the on-concept invariant audit: each MUST carry a descriptor in
#                 that concept's descendantUis. Assert it, do not trust it.
#
# Attribution is an EXACT token match against the marked words, not a substring and not a stem
# match. Substring (`contains`) over-counted: a 3-char gloss token scored any word it sat inside
# ("car"⊂"cardiac", "ras"⊂"contrast", "gene"⊂"generation"), which is the WRONG direction for a ship
# gate. Exact tokens under-count instead — a gloss word the analyzer stemmed before marking
# ("decline" vs a marked "Declining") is missed — and under-count is the safe direction.
#
# Run: jq -f inwords-population.jq scripts/search-eval/spine-eval-out/gloss-0.5.raw.json
def marks: [ (.titleHtml // "") | scan("<mark>([^<]+)</mark>") | .[0] | ascii_downcase ];
def marktokens: [ (.titleHtml // "") | scan("<mark>([^<]+)</mark>") | .[0]
                  | ascii_downcase | splits("[^a-z0-9]+") ] | map(select(length > 0));
def glosswords: [ (.glossTerms // "") | ascii_downcase | splits("[^a-z0-9]+") ]
                | map(select(length >= 3));

[ (.evidence // {}) | to_entries[]
  | .key as $fixture
  | (.value[].blocks[] | . as $b
     | ($b | marks) as $m
     | ($b | marktokens) as $mt
     | ($b | glosswords) as $g
     | (($m | length) > 0 and ($g | any(. as $w | ($mt | index($w)) != null))) as $gm
     | {
         fixture: $fixture,
         term: $b.term,
         pmid: $b.pmid,
         titleHtml: $b.titleHtml,
         marked: (($m | length) > 0),
         glossMarked: $gm,
         # A gloss mark the officer sees WITHOUT expanding: it must also be on the lead pub.
         glossLeadMarked: ($gm and ($b.leadMarked // false)),
       })
] as $rows
| ($rows
    | group_by([.fixture, .term])
    | map({
        fixture: .[0].fixture,
        term: .[0].term,
        pool: length,
        marked: (map(select(.marked)) | length),
        glossMarked: (map(select(.glossMarked)) | length),
        leadMarked: (map(select(.glossLeadMarked)) | length),
        pmids: (map(select(.glossMarked) | .pmid) | map(select(. != null)) | unique),
        examples: (map(select(.glossMarked) | .titleHtml) | .[0:2]),
      } | .rate = ((.leadMarked / .pool * 1000 | floor) / 1000)
        | .reachRate = ((.glossMarked / .pool * 1000 | floor) / 1000))
  ) as $perConcept
| {
    arm: .arm,
    overall: {
      concepts: ($perConcept | length),
      blocks: ($rows | length),
      marked: ($rows | map(select(.marked)) | length),
      glossMarked: ($rows | map(select(.glossMarked)) | length),
      leadMarked: ($rows | map(select(.glossLeadMarked)) | length),
      # `rate` is the FACE rate (lead pub only) — read the ship criterion against this one.
      rate: (($rows | length) as $n
             | if $n > 0 then (($rows | map(select(.glossLeadMarked)) | length) / $n * 1000 | floor) / 1000
               else 0 end),
      reachRate: (($rows | length) as $n
             | if $n > 0 then (($rows | map(select(.glossMarked)) | length) / $n * 1000 | floor) / 1000
               else 0 end),
    },
    perConcept: ($perConcept | sort_by(-.rate)),
  }
