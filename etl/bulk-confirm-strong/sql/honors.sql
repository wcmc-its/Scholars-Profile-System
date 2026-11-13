-- STRONG pending honors (/edit/honors-queue): the verified rule, run read-only on prod
-- Aurora 2026-11-12. Selected AGAIN at run time by etl/bulk-confirm-strong, uncapped.
-- Excludes contested lines, nickname matches, date suspects, duplicates of any other
-- row for the same award, and same-organization near-year rows.
WITH line_stats AS (
  SELECT source_ref,
         COUNT(*) AS n_rows,
         COUNT(DISTINCT CASE WHEN status = 'pending' THEN cwid END) AS pending_cwids,
         SUM(status = 'published') AS n_published
  FROM honor
  WHERE source_ref IS NOT NULL
  GROUP BY source_ref
),
base AS (
  SELECT h.id, h.cwid, h.name, h.organization, h.year, h.source, h.source_ref, h.evidence,
         s.status AS scholar_status, s.deleted_at, s.primary_title,
         COALESCE(l.n_rows, 1) AS n_rows,
         COALESCE(l.pending_cwids, 1) AS pending_cwids,
         CHAR_LENGTH(h.source_ref) - CHAR_LENGTH(REPLACE(h.source_ref, '|', '')) AS pipes,
         CAST(LOWER(TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(h.source_ref, '|', 2), '|', -1))) AS BINARY) AS listed,
         CAST(LOWER(SUBSTRING_INDEX(TRIM(REGEXP_REPLACE(SUBSTRING_INDEX(s.preferred_name, ',', 1), '[[:space:]]+', ' ')), ' ', 1)) AS BINARY) AS fn,
         CAST(LOWER(SUBSTRING_INDEX(TRIM(REGEXP_REPLACE(SUBSTRING_INDEX(s.preferred_name, ',', 1), '[[:space:]]+', ' ')), ' ', -1)) AS BINARY) AS ln,
         CAST(LOWER(COALESCE(h.evidence, '')) AS BINARY) AS ev
  FROM honor h
  JOIN scholar s ON s.cwid = h.cwid
  LEFT JOIN line_stats l ON l.source_ref = h.source_ref
  WHERE h.status = 'pending'
),
cls AS (
  SELECT b.*,
    (b.source_ref IS NOT NULL AND b.pipes = 2 AND LENGTH(b.listed) > 0 AND LENGTH(b.fn) > 0
       AND INSTR(b.listed, b.fn) > 0 AND INSTR(b.listed, b.ln) > 0) AS name_ok,
    (LEFT(b.ev, 8) = 'nickname') AS nickname,
    (CASE
       WHEN b.evidence IS NULL THEN 1
       WHEN HEX(LEFT(b.evidence, 1)) = 'E2809C' THEN
         (INSTR(b.ev, b.ln) > 0 AND INSTR(b.ev, 'weill cornell') > 0
          AND (INSTR(b.ev, CAST(LOWER(b.name) AS BINARY)) > 0
               OR INSTR(b.ev, CAST(LOWER(b.organization) AS BINARY)) > 0))
       ELSE (INSTR(b.ev, 'weill cornell') > 0 OR INSTR(b.ev, 'institution match') > 0
             OR INSTR(b.ev, 'links this scholar') > 0)
     END) AS evidence_ok,
    (b.year IS NOT NULL
       AND REGEXP_LIKE(COALESCE(b.primary_title, ''), 'postdoc|fellow|resident|student|instructor|assistant', 'i')
       AND YEAR(UTC_DATE()) - b.year > 30) AS junior_old_award,
    (b.year IS NOT NULL AND b.year < COALESCE((
       SELECT MIN(e.year) FROM education e
       WHERE e.cwid = b.cwid AND e.year IS NOT NULL
         AND REGEXP_LIKE(REPLACE(e.degree, '.', ''), '\\b(MD|PHD|DO|DPHIL|SCD|DRPH|PHARMD|DVM|DDS|DMD|EDD|PSYD|DNP)\\b', 'i')
     ), -1)) AS predates_doctorate,
    EXISTS (SELECT 1 FROM honor d
            WHERE d.cwid = b.cwid AND d.id <> b.id
              AND d.organization = b.organization AND d.name = b.name) AS dup_any,
    EXISTS (SELECT 1 FROM honor d
            WHERE d.cwid = b.cwid AND d.id <> b.id
              AND d.status IN ('published', 'pending')
              AND d.organization = b.organization
              AND (d.year IS NULL OR b.year IS NULL OR ABS(d.year - b.year) <= 1)) AS near_dup
  FROM base b
),
banded AS (
  SELECT c.*,
    (c.source NOT IN ('SELF', 'CURATOR')
      AND c.scholar_status = 'active' AND c.deleted_at IS NULL
      AND c.n_rows = 1
      AND c.name_ok AND NOT c.nickname AND c.evidence_ok
      AND NOT c.junior_old_award AND NOT c.predates_doctorate
      AND NOT c.dup_any AND NOT c.near_dup) AS strong
  FROM cls c
)
SELECT id, cwid, source, year, organization, name,
       CASE WHEN evidence IS NULL THEN 'seed-name-only'
            WHEN HEX(LEFT(evidence, 1)) = 'E2809C' THEN 'newsroom-quote'
            ELSE 'roster-note' END AS evidence_kind
FROM banded
WHERE strong = 1
ORDER BY CASE WHEN source LIKE 'LIST:%' THEN 0 WHEN evidence IS NULL THEN 1 ELSE 2 END,
         source, year DESC, organization, name, id
