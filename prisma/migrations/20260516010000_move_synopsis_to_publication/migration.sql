-- Move `synopsis` from publication_topic (per-(pmid, cwid, parent_topic))
-- to publication (per-pmid). The TOPIC# producer denormalized the same
-- value across N rows for one pmid; consumers had to MAX-collapse to get
-- one value back. Per-pmid storage matches the data's actual shape and
-- avoids the drift risk if upstream ever publishes divergent values
-- (issue #329).
--
-- Step 1 — add the new column on publication.
ALTER TABLE `publication`
    ADD COLUMN `synopsis` TEXT NULL;

-- Step 2 — backfill from publication_topic. MAX() is arbitrary dedupe;
-- if any rows ever drifted in the past, we pick one deterministically.
-- Same tiebreak the lib/api/publication-detail.ts MAX-fallback used.
UPDATE `publication` p
JOIN (
    SELECT `pmid`, MAX(`synopsis`) AS `synopsis`
    FROM `publication_topic`
    WHERE `synopsis` IS NOT NULL
    GROUP BY `pmid`
) s ON s.`pmid` = p.`pmid`
SET p.`synopsis` = s.`synopsis`;

-- Step 3 — drop the old column. The DDB ETL stops writing here in the
-- same PR so this drop is safe.
ALTER TABLE `publication_topic`
    DROP COLUMN `synopsis`;
