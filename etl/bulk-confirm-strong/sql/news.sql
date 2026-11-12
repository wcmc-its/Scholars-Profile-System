-- STRONG pending newsroom mentions (/edit/news-queue, outlet IS NULL): the verified rule,
-- run read-only on prod Aurora 2026-11-12. Selected AGAIN at run time by
-- etl/bulk-confirm-strong, uncapped.
-- Read-only. Strong candidates (green HIGH + 'Newsroom tag' pills, uncontested) in the queue's certainty order
-- (all HIGH, so = recency: newest article first, undated last, created_at ASC tie-break; news-queue.ts:576-587).
SELECT
  nm.id,
  nm.cwid,
  s.slug,
  nm.likelihood,
  nm.match_basis,
  nm.detected_name,
  LEFT(nm.title, 140)       AS article_title,
  DATE(nm.published_at)     AS published_on,
  LEFT(nm.context_snippet, 200) AS snippet,
  nm.url
FROM news_mention nm
JOIN scholar s
  ON s.cwid = nm.cwid AND s.deleted_at IS NULL AND s.status = 'active'
WHERE nm.status = 'pending'
  AND nm.outlet IS NULL
  AND nm.source = 'NAME'
  AND nm.duplicate_of IS NULL
  AND nm.likelihood = 'HIGH'
  AND nm.match_basis = 'TAG'
  AND nm.context_snippet IS NOT NULL
  AND nm.entered_by_cwid IS NULL
  AND nm.decision_id IS NULL
  AND nm.source_ref IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM news_mention o
                  WHERE o.source_ref = nm.source_ref AND o.id <> nm.id)
  AND NOT EXISTS (SELECT 1 FROM news_mention d
                  WHERE d.cwid = nm.cwid AND d.id <> nm.id
                    AND d.title = nm.title AND d.published_at <=> nm.published_at)
  AND NOT EXISTS (SELECT 1 FROM scholar s2
                  WHERE s2.cwid <> nm.cwid AND s2.deleted_at IS NULL
                    AND (s2.preferred_name = nm.detected_name OR s2.full_name = nm.detected_name))
  AND LOWER(nm.title) NOT REGEXP '(^|[^a-z])(in memoriam|obituar[a-z]*|remembering|tributes?|passed away|dies|died)([^a-z]|$)'
ORDER BY nm.published_at IS NULL, nm.published_at DESC, nm.created_at ASC
