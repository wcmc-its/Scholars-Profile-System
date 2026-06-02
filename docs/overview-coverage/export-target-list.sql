-- Export: prominent full-time faculty WITHOUT an overview statement.
-- Output is RFC-4180 CSV (text fields double-quoted, internal quotes doubled),
-- header emitted as the first row, ordered by prominence (confirmed pubs desc,
-- then active PI grants desc).
--
-- Run (host MariaDB, canonical local dev DB):
--   mysql --no-defaults --socket=/tmp/mysql.sock -u paulalbert scholars -N -B \
--     < docs/overview-coverage/export-target-list.sql > docs/overview-coverage/target-list-prominent-uncovered.csv
--
-- Written for MySQL/MariaDB. `grant` is a reserved word -> backtick-quoted.
-- "Effective overview" note: this filters on scholar.overview only. At the time
-- of capture, field_override held 0 overview rows, so scholar.overview == the
-- effective overview. If self-edit overrides exist, LEFT JOIN field_override
-- (entity_type='scholar', field_name='overview') and treat a present override
-- as covered.

SELECT line FROM (
  SELECT 0 AS sk, 9000000000 AS o1, 0 AS o2,
    'rank_tier,cwid,name,primary_title,primary_department,confirmed_pubs,active_pi_grants,max_pub_impact' AS line
  UNION ALL
  SELECT 1 AS sk, t.pub_count AS o1, t.active_pi AS o2,
    CONCAT_WS(',',
      CASE
        WHEN t.pub_count >= 100 THEN 'A_100plus_pubs'
        WHEN t.pub_count >= 50  THEN 'B_50to99_pubs'
        WHEN t.active_pi >= 1   THEN 'C_active_PI'
        WHEN t.pub_count >= 20  THEN 'D_20to49_pubs'
        ELSE 'E_tail'
      END,
      CONCAT('"', REPLACE(t.cwid, '"', '""'), '"'),
      CONCAT('"', REPLACE(t.nm,   '"', '""'), '"'),
      CONCAT('"', REPLACE(t.ti,   '"', '""'), '"'),
      CONCAT('"', REPLACE(t.dp,   '"', '""'), '"'),
      t.pub_count,
      t.active_pi,
      COALESCE(CAST(t.max_impact AS CHAR), '')
    ) AS line
  FROM (
    SELECT
      s.cwid AS cwid,
      s.preferred_name AS nm,
      COALESCE(s.primary_title, '') AS ti,
      COALESCE(s.primary_department, '') AS dp,
      COUNT(DISTINCT CASE WHEN pa.is_confirmed = 1 THEN pa.pmid END) AS pub_count,
      (SELECT COUNT(*) FROM `grant` g
         WHERE g.cwid = s.cwid
           AND g.end_date >= CURDATE()
           AND g.role IN ('Principal Investigator','PI','Contact PI','MPI')) AS active_pi,
      (SELECT ROUND(MAX(p.impact_score), 1)
         FROM publication_author pa2
         JOIN publication p ON p.pmid = pa2.pmid
         WHERE pa2.cwid = s.cwid AND pa2.is_confirmed = 1) AS max_impact
    FROM scholar s
    LEFT JOIN publication_author pa ON pa.cwid = s.cwid
    WHERE s.deleted_at IS NULL
      AND s.role_category = 'full_time_faculty'
      AND (s.overview IS NULL OR TRIM(s.overview) = '')
    GROUP BY s.cwid, s.preferred_name, s.primary_title, s.primary_department
  ) t
) z
ORDER BY sk ASC, o1 DESC, o2 DESC;
