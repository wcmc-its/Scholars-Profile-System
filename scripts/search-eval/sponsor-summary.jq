# Aggregate a sponsor-eval scorecard. stdin: the array of per-prompt score objects.
#
# An UNMEASURED fixture (the route never gave us a ranking — breaker 502, stale cookie, non-JSON)
# carries {unmeasured: true} and null scores. It is NOT a ranking of zero, so it must not enter the
# mean: a run where the box was merely busy would otherwise read as a ranking collapse. It is also
# excluded from the coverage fraction, whose denominator would otherwise charge us for gold people
# the ranker was never asked about.
#
# out: {scored, unmeasured, total, mean_ndcg, mean_rho, found, n_ideal}
#      mean_ndcg / mean_rho are null when nothing was scorable.

[ .[] | select(.unmeasured != true) ]              as $ok
| [ $ok[] | select(.ndcg_at_k != null) ]           as $nd
| [ $ok[] | select(.spearman  != null) ]           as $sp
| {
    scored:     ($ok | length),
    unmeasured: ([ .[] | select(.unmeasured == true) ] | length),
    total:      length,
    mean_ndcg:  (if ($nd | length) == 0 then null else ([ $nd[].ndcg_at_k ] | add / ($nd | length)) end),
    mean_rho:   (if ($sp | length) == 0 then null else ([ $sp[].spearman  ] | add / ($sp | length)) end),
    found:      ([ $ok[].found   ] | add // 0),
    n_ideal:    ([ $ok[].n_ideal ] | add // 0)
  }
