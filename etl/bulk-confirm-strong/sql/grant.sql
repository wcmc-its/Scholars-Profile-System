-- STRONG pending grant attribution reviews (/edit/grant-attribution-queue): the verified
-- rule, run read-only on prod Aurora 2026-11-12. Selected AGAIN at run time by
-- etl/bulk-confirm-strong, uncapped. Score +1 in the queue band, a substantive positive
-- cue, no negative or veto cue, fresh against the latest score, no other active hide,
-- and the NIH core held by no other scholar.
WITH pend AS (
  SELECT r.id, r.cwid, r.grant_external_id, r.score, r.band, r.cues, r.award,
         r.first_seen_at,
         SUBSTRING_INDEX(r.grant_external_id, ':', -1) AS core
  FROM grant_attribution_review r
  JOIN `grant` g ON g.id = r.grant_external_id
  JOIN grant_attribution_score gs ON gs.grant_external_id = r.grant_external_id
                                 AND gs.band = 'queue'
                                 AND gs.evidence_key = r.evidence_key
  WHERE r.status = 'pending'
    AND r.band = 'queue'
    AND r.score >= 1
    AND r.decided_by_cwid IS NULL
    AND r.reopened_at IS NULL
),
cue AS (
  SELECT p.id,
         MAX(jt.weight < 0 OR jt.cue_id = 'infoed_other_wcm_pi_named') AS any_against,
         MAX(jt.cue_id IN ('prior_institution','affiliate_org','copi_coauthor') AND jt.weight >= 2) AS solid_for,
         GROUP_CONCAT(CONCAT(jt.cue_id, ':', jt.weight) ORDER BY ABS(jt.weight) DESC SEPARATOR ', ') AS cue_list
  FROM pend p
  JOIN grant_attribution_review rr ON rr.id = p.id
  CROSS JOIN JSON_TABLE(CAST(rr.cues AS JSON), '$[*]' COLUMNS (
      cue_id VARCHAR(64) PATH '$.id',
      weight INT PATH '$.weight')) AS jt
  GROUP BY p.id
)
SELECT p.id AS review_id,
       p.cwid,
       p.grant_external_id,
       p.score,
       p.band,
       c.cue_list,
       JSON_UNQUOTE(JSON_EXTRACT(p.award, '$.coreProjectNum')) AS core_project_num,
       JSON_UNQUOTE(JSON_EXTRACT(p.award, '$.title'))          AS award_title,
       p.first_seen_at
FROM pend p
JOIN cue c ON c.id = p.id
WHERE c.any_against = 0
  AND c.solid_for = 1
  AND NOT EXISTS (SELECT 1 FROM suppression s
                  WHERE s.entity_type = 'grant' AND s.entity_id = p.grant_external_id
                    AND s.revoked_at IS NULL
                    AND s.created_by <> 'system-unverified')
  AND NOT EXISTS (SELECT 1 FROM `grant` g2
                  WHERE g2.external_id LIKE CONCAT('reporter:%:', p.core) AND g2.cwid <> p.cwid)
  AND NOT EXISTS (SELECT 1 FROM grant_attribution_score s2
                  WHERE s2.grant_external_id LIKE CONCAT('reporter:%:', p.core) AND s2.cwid <> p.cwid)
  AND NOT EXISTS (SELECT 1 FROM `grant` g3
                  WHERE g3.source = 'InfoEd' AND g3.cwid <> p.cwid
                    AND REPLACE(g3.award_number, ' ', '') LIKE CONCAT('%', p.core, '%'))
ORDER BY p.score DESC, p.first_seen_at ASC
