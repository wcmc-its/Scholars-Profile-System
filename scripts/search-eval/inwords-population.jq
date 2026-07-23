# MATCHA_GLOSS_INWORDS — the §1 acceptance measurement for the "in their words" gloss-evidence line
# (docs/2026-07-23-matcha-inwords-merged-next-steps-handoff.md). Reads a spine-eval-run.ts artifact
# ($arm.raw.json, which carries `.evidence`) and reports, per (fixture, concept term):
#   pool      = candidates that matched the concept (have an evidence block for it)
#   populated = those whose block carries a real `inWords` fragment (<mark>-gated upstream, so a
#               populated block is an HONEST "the scholar used the gloss's own word")
#   rate      = populated / pool     ← the ship signal: does the line earn its vertical space?
#   examples  = up to two real fragments, for the "never misleading when absent" eyeball
#
# Run:  jq -f inwords-population.jq scripts/search-eval/spine-eval-out/gloss-0.5.raw.json
[ (.evidence // {}) | to_entries[]
  | .key as $fixture
  | (.value[].blocks[] | { fixture: $fixture, term, inWords, has: (.inWords != null) })
] as $rows
| ($rows
    | group_by([.fixture, .term])
    | map({
        fixture: .[0].fixture,
        term: .[0].term,
        pool: length,
        populated: (map(select(.has)) | length),
        examples: (map(.inWords) | map(select(. != null)) | .[0:2]),
      } | .rate = ((.populated / .pool * 1000 | floor) / 1000))
  ) as $perConcept
| {
    arm: .arm,
    overall: {
      concepts: ($perConcept | length),
      blocks: ($rows | length),
      populated: ($rows | map(select(.has)) | length),
      rate: (($rows | length) as $n
             | if $n > 0 then (($rows | map(select(.has)) | length) / $n * 1000 | floor) / 1000 else 0 end),
    },
    perConcept: ($perConcept | sort_by(-.rate)),
  }
