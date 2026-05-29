-- =============================================================================
-- #393 — Suppression search-index reconciler audit (ADR-005 failure-model layer 3)
-- Issues: #393 (durable reconciler) · #356 Phase 4b (fast-path + nightly rebuild)
-- Refs:   docs/ADR-005-manual-override-layer.md (§ failure model)
--         lib/edit/search-reconcile.ts · lib/edit/search-suppression.ts
-- =============================================================================
--
-- A scholar/publication suppression is STALE when its sentinel
-- `search_reflected_at` is NULL past a short grace window: the row's latest
-- state transition (the revoke if present, else the create) has not been
-- reflected into the OpenSearch index. A successful reflect stamps now(); a
-- revoke resets it to NULL; create defaults NULL. Other entity types have no
-- search fast-path and are excluded.
--
-- COALESCE(revoked_at, created_at) is the latest transition (a revoke always
-- post-dates its create), so it doubles as the grace cutoff column.

-- 1. CURRENT BACKLOG -- exactly what the next reconciler run will pick up
--    (60s grace). Healthy steady state: zero rows.
SELECT id, entity_type, entity_id, contributor_cwid,
       created_at, revoked_at, search_reflected_at
FROM   suppression
WHERE  entity_type IN ('scholar', 'publication')
  AND  search_reflected_at IS NULL
  AND  COALESCE(revoked_at, created_at) < (NOW() - INTERVAL 60 SECOND)
ORDER BY COALESCE(revoked_at, created_at) ASC;

-- 2. UNRECONCILED COUNT -- single number for a dashboard / spot check.
SELECT COUNT(*) AS unreconciled
FROM   suppression
WHERE  entity_type IN ('scholar', 'publication')
  AND  search_reflected_at IS NULL
  AND  COALESCE(revoked_at, created_at) < (NOW() - INTERVAL 60 SECOND);

-- 3. AGE OF THE OLDEST UNRECONCILED ROW (seconds) -- SLA-breach detector. The
--    reconciler targets ≤5 min; a value climbing past ~300 means the worker is
--    not draining (rule disabled, IAM gap, repeated reflect failure).
SELECT TIMESTAMPDIFF(
         SECOND,
         MIN(COALESCE(revoked_at, created_at)),
         NOW()
       ) AS oldest_unreconciled_age_seconds
FROM   suppression
WHERE  entity_type IN ('scholar', 'publication')
  AND  search_reflected_at IS NULL
  AND  COALESCE(revoked_at, created_at) < (NOW() - INTERVAL 60 SECOND);
