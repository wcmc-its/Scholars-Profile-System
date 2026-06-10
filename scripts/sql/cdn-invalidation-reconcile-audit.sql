-- =============================================================================
-- #353 — CloudFront-invalidation outbox reconciler audit (ADR-005 layer 3)
-- Issues: #353 (durable outbox + reconciler) · #356 (write-path best-effort send)
-- Refs:   docs/ADR-005-manual-override-layer.md (§ failure model)
--         lib/edit/cdn-reconcile.ts · lib/edit/revalidation.ts
-- =============================================================================
--
-- A `cdn_invalidation` row is PENDING when its sentinel `invalidated_at` is NULL
-- past a short grace window: the write-path `CreateInvalidation` never landed,
-- so the edge copy is still stale up to the ≤24h CloudFront TTL. A successful
-- (re)invalidation stamps now(); each failed retry increments `attempts` and a
-- row that reaches the cap (default 10) is EXHAUSTED — the reconciler stops
-- retrying it and pages.
--
-- Unlike #393's sentinel, the `paths` here are NOT recomputable, so they are
-- persisted verbatim and the reconciler replays them. Dormant (no rows) until
-- SCHOLARS_CLOUDFRONT_DISTRIBUTION_ID is set.

-- 1. CURRENT BACKLOG -- exactly what the next reconciler run will pick up
--    (60s grace, attempts < 10). Healthy steady state: zero rows.
SELECT id, paths, attempts, last_error, created_at, invalidated_at
FROM   cdn_invalidation
WHERE  invalidated_at IS NULL
  AND  attempts < 10
  AND  created_at < (NOW() - INTERVAL 60 SECOND)
ORDER BY created_at ASC;

-- 2. UNRECONCILED COUNT -- single number for a dashboard / spot check.
SELECT COUNT(*) AS unreconciled
FROM   cdn_invalidation
WHERE  invalidated_at IS NULL
  AND  attempts < 10
  AND  created_at < (NOW() - INTERVAL 60 SECOND);

-- 3. STUCK / EXHAUSTED ROWS -- attempts at or past the cap. These no longer
--    retry: the purge is permanently failing (IAM regression, deleted
--    distribution, malformed payload). Each should have fired an
--    `edit_cdn_reconcile_exhausted` alarm line. Steady state: zero rows.
SELECT id, paths, attempts, last_error, created_at, invalidated_at
FROM   cdn_invalidation
WHERE  invalidated_at IS NULL
  AND  attempts >= 10
ORDER BY created_at ASC;

-- 4. AGE OF THE OLDEST UNRECONCILED ROW (seconds) -- SLA-breach detector. The
--    reconciler targets ≤5 min; a value climbing past ~300 means the worker is
--    not draining (rule disabled, IAM gap, repeated invalidation failure).
SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) AS oldest_unreconciled_age_seconds
FROM   cdn_invalidation
WHERE  invalidated_at IS NULL
  AND  attempts < 10
  AND  created_at < (NOW() - INTERVAL 60 SECOND);

-- 5. AGE-BUCKET HISTOGRAM of pending rows -- where the backlog (if any) sits.
SELECT CASE
         WHEN created_at >= (NOW() - INTERVAL 5 MINUTE)  THEN '0-5m'
         WHEN created_at >= (NOW() - INTERVAL 1 HOUR)    THEN '5m-1h'
         WHEN created_at >= (NOW() - INTERVAL 1 DAY)     THEN '1h-1d'
         ELSE '>1d'
       END AS age_bucket,
       COUNT(*) AS pending_rows
FROM   cdn_invalidation
WHERE  invalidated_at IS NULL
  AND  created_at < (NOW() - INTERVAL 60 SECOND)
GROUP BY age_bucket
ORDER BY FIELD(age_bucket, '0-5m', '5m-1h', '1h-1d', '>1d');
