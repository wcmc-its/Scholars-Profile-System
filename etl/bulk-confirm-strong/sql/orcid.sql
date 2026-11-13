-- STRONG open ORCID pairs (/edit/orcid-queue): the verified rule, run read-only on prod
-- Aurora 2026-11-12. Selected AGAIN at run time by etl/bulk-confirm-strong, uncapped.
-- Band strong + inst_match + ReCiter read with zero rejected works, one open pair per
-- scholar, one cwid per iD, iD held by nobody, no dismissal of any kind.
WITH open_pair AS (
  SELECT e.cwid, e.orcid, e.band, e.inst_match, e.history_match, e.name_agrees, e.shared,
         e.works_total, e.competitor, e.competitor_cwids, e.competitor_orcids, e.evidence_detail,
         e.computed_at, s.orcid AS on_file
  FROM orcid_candidate_evidence e
  JOIN scholar s ON s.cwid = e.cwid AND s.status = 'active' AND s.deleted_at IS NULL
  LEFT JOIN orcid_dismissal d ON d.cwid = e.cwid AND d.orcid = e.orcid
  WHERE d.cwid IS NULL
    AND (s.orcid IS NULL OR s.orcid <> e.orcid)
    AND e.band IN ('email_verified','strong','shared_only','moderate','weak')
),
per_scholar AS (SELECT cwid, COUNT(*) AS n_open FROM open_pair GROUP BY cwid),
per_orcid   AS (SELECT orcid, COUNT(DISTINCT cwid) AS n_cwid FROM orcid_candidate_evidence GROUP BY orcid),
held        AS (SELECT orcid, COUNT(*) AS n_held FROM scholar WHERE orcid IS NOT NULL GROUP BY orcid),
rpm         AS (SELECT cwid, orcid, MAX(articles_rejected) AS max_rej FROM orcid_candidate GROUP BY cwid, orcid),
any_dism    AS (SELECT DISTINCT cwid FROM orcid_dismissal)
SELECT o.cwid,
       o.orcid,
       o.band,
       o.shared,
       o.works_total,
       ROUND(o.shared / NULLIF(o.works_total, 0), 2) AS share_of_record,
       o.inst_match,
       o.history_match,
       (SELECT GROUP_CONCAT(DISTINCT c.source ORDER BY c.source SEPARATOR ',')
          FROM orcid_candidate c WHERE c.cwid = o.cwid AND c.orcid = o.orcid) AS sources,
       s.preferred_name,
       s.primary_department,
       o.computed_at
FROM open_pair o
JOIN scholar s      ON s.cwid = o.cwid
JOIN per_scholar ps ON ps.cwid = o.cwid
JOIN per_orcid  po  ON po.orcid = o.orcid
LEFT JOIN held h    ON h.orcid = o.orcid
LEFT JOIN rpm  r    ON r.cwid = o.cwid AND r.orcid = o.orcid
LEFT JOIN any_dism ad ON ad.cwid = o.cwid
WHERE o.band = 'strong'
  AND o.on_file IS NULL
  AND o.competitor = 0
  AND JSON_LENGTH(o.competitor_cwids) = 0
  AND JSON_LENGTH(o.competitor_orcids) = 0
  AND o.name_agrees = 1
  AND o.shared >= 3
  AND o.inst_match = 1
  AND o.evidence_detail IS NOT NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(o.evidence_detail, '$.workStatus.reciterRead')) = 'true'
  AND IFNULL(CAST(JSON_UNQUOTE(JSON_EXTRACT(o.evidence_detail, '$.workStatus.counts.rejected')) AS UNSIGNED), 0) = 0
  AND ps.n_open = 1
  AND po.n_cwid = 1
  AND IFNULL(h.n_held, 0) = 0
  AND IFNULL(r.max_rej, 0) = 0
  AND ad.cwid IS NULL
ORDER BY share_of_record DESC, o.shared DESC, o.cwid
