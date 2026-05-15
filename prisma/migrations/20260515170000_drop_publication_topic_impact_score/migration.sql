-- AlterTable: drop the publication_topic.impact_score mirror column.
-- The canonical column is publication.impact_score (issue #316 PR-A). All
-- consumers were migrated through #316 PR-B-1, PR-B-2, and PR-B-finalize.
-- See lib/api/profile.ts, lib/api/topics.ts, lib/api/spotlight.ts, and
-- etl/search-index/index.ts for the migrated read paths.
ALTER TABLE `publication_topic`
    DROP COLUMN `impact_score`;
