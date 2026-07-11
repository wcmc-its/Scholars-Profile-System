# Score ONE sponsor-match prompt: a graded gold ordering vs the ranker's actual output.
# Sibling of score_query.jq, but graded (nDCG + Spearman) rather than binary (MRR/top-k),
# because sponsor ranking cares about ORDER QUALITY across a judged pool, not just "found".
#
# stdin : $actual — a JSON array of cwids in the ranker's ranked order, e.g. ["aaa2001","bbb2002",...]
#         (sponsor-eval.sh extracts this from the route's {researchers:[{cwid}]} or an ACTUAL file).
# args  : --argjson ideal [{cwid, grade}]  (grade 0..3; the hand-ranked gold set)
#         --argjson k <int>                (nDCG cutoff, e.g. 20)
#         --arg     id <string>            (prompt id, for the scorecard)
#
# out   : {id, n_ideal, found, coverage, k, ndcg_at_k, spearman, missing[]}
#   coverage  = |ideal ∩ actual| / |ideal|  — did the ranker even RETURN the judged people?
#               (nDCG can look fine while half the gold pool is missing — always read this too.)
#   ndcg_at_k = DCG@k / IDCG@k with gain = 2^grade - 1 (top-heavy). null if no positive grades.
#   spearman  = rank correlation over the intersection, re-ranked 1..n. null if <2 common items.

def log2($x): (($x | log) / (2 | log));
def gain($g): (pow(2; $g) - 1);

. as $actual
| ($ideal | map(.cwid))                                            as $idealCwids
| ($ideal | map(.grade) | sort | reverse)                          as $idealGrades
| ($ideal | map({ (.cwid): .grade }) | add // {})                  as $gradeOf

# DCG@k over the actual order (unjudged cwids contribute grade 0)
| ([ range(0; ([($actual | length), $k] | min)) as $i
     | gain(($gradeOf[$actual[$i]]) // 0) / log2($i + 2) ] | add // 0) as $dcg
# IDCG@k over the ideal grades, sorted desc
| ([ range(0; ([($idealGrades | length), $k] | min)) as $i
     | gain($idealGrades[$i]) / log2($i + 2) ] | add // 0)          as $idcg

# intersection = judged cwids the ranker actually returned
| ([ $idealCwids[] | select(. as $c | ($actual | index($c)) != null) ]) as $found
| ($found | length)                                                as $n

# ideal ranks over the intersection (by grade desc; fixture order breaks ties — jq sort is stable)
| ([ $ideal[] | select(.cwid as $c | ($found | index($c)) != null) ]
     | sort_by(- .grade) | to_entries | map({ (.value.cwid): (.key + 1) }) | add // {}) as $idealRank
# actual ranks over the intersection (by position in the actual list)
| ([ $actual[] | select(. as $c | ($found | index($c)) != null) ]
     | to_entries | map({ (.value): (.key + 1) }) | add // {})      as $actualRank
| ([ $found[] | (($idealRank[.] - $actualRank[.]) | . * .) ] | add // 0) as $sumd2

| {
    id: $id,
    n_ideal: ($ideal | length),
    found: $n,
    coverage: (if ($ideal | length) == 0 then null else ($n / ($ideal | length)) end),
    k: $k,
    ndcg_at_k: (if $idcg <= 0 then null else ($dcg / $idcg) end),
    spearman:  (if $n < 2 then null else (1 - (6 * $sumd2) / ($n * ($n * $n - 1))) end),
    missing: [ $idealCwids[] | select(. as $c | ($actual | index($c)) == null) ]
  }
