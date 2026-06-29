-- Opportunity grant→researcher matcher inputs (GRANT# contract v3): the LLM-compiled
-- match DSL + weighted BM25 query, consumed by the flag-gated subtopic-grain reverse
-- matcher. Both nullable, no backfill: rows fill on the next ReciterAI reproject.
ALTER TABLE `opportunity`
  ADD COLUMN `match_dsl` JSON NULL,
  ADD COLUMN `match_query` JSON NULL;

-- Pool query for the subtopic-grain matcher filters publication_topic on
-- primary_subtopic_id; index it so the new path is not a table scan.
CREATE INDEX `publication_topic_primary_subtopic_id_idx` ON `publication_topic`(`primary_subtopic_id`);
