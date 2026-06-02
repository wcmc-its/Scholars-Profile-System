-- Audit: overview-statement coverage across the scholar population.
-- Diagnostic companion to export-target-list.sql. Run each query independently.
--
--   mysql --no-defaults --socket=/tmp/mysql.sock -u paulalbert scholars < this-file
--
-- Written for MySQL/MariaDB. "Covered" = scholar.overview is non-NULL and not
-- blank. NOTE the effective-overview caveat: the public profile merges
-- scholar.overview with a field_override (entity_type='scholar',
-- field_name='overview'). At capture time field_override held 0 overview rows,
-- so the two are identical; if self-edit overrides land, add:
--   LEFT JOIN field_override fo
--     ON fo.entity_type='scholar' AND fo.field_name='overview' AND fo.entity_id = s.cwid
-- and treat (fo.id IS NOT NULL OR overview non-blank) as covered.

-- 1. Headline counts.
SELECT 'total_active_scholars' AS metric, COUNT(*) AS n
  FROM scholar WHERE deleted_at IS NULL
UNION ALL SELECT 'overview_non_blank',
  COUNT(*) FROM scholar
  WHERE deleted_at IS NULL AND overview IS NOT NULL AND TRIM(overview) <> ''
UNION ALL SELECT 'field_override_overview_rows',
  COUNT(*) FROM field_override WHERE entity_type='scholar' AND field_name='overview';

-- 2. Coverage by role_category.
SELECT COALESCE(role_category,'(null)') AS role_category,
       COUNT(*) AS total,
       SUM(overview IS NOT NULL AND TRIM(overview) <> '') AS has_overview,
       ROUND(100.0*SUM(overview IS NOT NULL AND TRIM(overview) <> '')/COUNT(*),1) AS pct
FROM scholar WHERE deleted_at IS NULL
GROUP BY role_category ORDER BY total DESC;

-- 3. Full-time-faculty coverage by prominence (confirmed publication count).
WITH ft AS (
  SELECT s.cwid,
         (s.overview IS NOT NULL AND TRIM(s.overview) <> '') AS has_ov,
         COUNT(DISTINCT CASE WHEN pa.is_confirmed=1 THEN pa.pmid END) AS pubs
  FROM scholar s
  LEFT JOIN publication_author pa ON pa.cwid = s.cwid
  WHERE s.deleted_at IS NULL AND s.role_category='full_time_faculty'
  GROUP BY s.cwid, has_ov
)
SELECT CASE
         WHEN pubs>=200 THEN 'A. 200+'      WHEN pubs>=100 THEN 'B. 100-199'
         WHEN pubs>=50  THEN 'C. 50-99'     WHEN pubs>=20  THEN 'D. 20-49'
         WHEN pubs>=5   THEN 'E. 5-19'      WHEN pubs>=1   THEN 'F. 1-4'
         ELSE 'G. 0' END AS pub_bucket,
       COUNT(*) AS faculty, SUM(has_ov) AS covered,
       ROUND(100.0*SUM(has_ov)/COUNT(*),1) AS pct
FROM ft GROUP BY pub_bucket ORDER BY pub_bucket;

-- 4. High-value gap segments (overlapping, not mutually exclusive).
WITH ft AS (
  SELECT s.cwid,
         (s.overview IS NOT NULL AND TRIM(s.overview) <> '') AS has_ov,
         COUNT(DISTINCT CASE WHEN pa.is_confirmed=1 THEN pa.pmid END) AS pubs,
         (SELECT COUNT(*) FROM `grant` g WHERE g.cwid=s.cwid AND g.end_date>=CURDATE()
            AND g.role IN ('Principal Investigator','PI','Contact PI','MPI')) AS active_pi
  FROM scholar s
  LEFT JOIN publication_author pa ON pa.cwid = s.cwid
  WHERE s.deleted_at IS NULL AND s.role_category='full_time_faculty'
  GROUP BY s.cwid, has_ov
)
SELECT 'FT faculty total' AS segment, COUNT(*) AS faculty, SUM(has_ov) AS covered, COUNT(*)-SUM(has_ov) AS gap FROM ft
UNION ALL SELECT '100+ pubs',                   COUNT(*),SUM(has_ov),COUNT(*)-SUM(has_ov) FROM ft WHERE pubs>=100
UNION ALL SELECT '50+ pubs',                    COUNT(*),SUM(has_ov),COUNT(*)-SUM(has_ov) FROM ft WHERE pubs>=50
UNION ALL SELECT 'active PI grant',             COUNT(*),SUM(has_ov),COUNT(*)-SUM(has_ov) FROM ft WHERE active_pi>=1
UNION ALL SELECT '50+ pubs OR active PI grant', COUNT(*),SUM(has_ov),COUNT(*)-SUM(has_ov) FROM ft WHERE pubs>=50 OR active_pi>=1;

-- 5. Quality bands of the overviews that DO exist (matters for "look good").
SELECT CASE
         WHEN CHAR_LENGTH(overview)<200  THEN '1. stub (<200)'
         WHEN CHAR_LENGTH(overview)<600  THEN '2. thin (200-599)'
         WHEN CHAR_LENGTH(overview)<1500 THEN '3. solid (600-1499)'
         ELSE '4. rich (1500+)' END AS quality_band,
       COUNT(*) AS scholars
FROM scholar
WHERE deleted_at IS NULL AND overview IS NOT NULL AND TRIM(overview) <> ''
GROUP BY quality_band ORDER BY quality_band;
