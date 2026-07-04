-- Opportunity dense relevance map (GRANT# contract v4): match_rel = { pmid: cosine∈[0,1] }
-- (Bedrock Titan v2), a precomputed dense alternative to the live BM25 relevance boost for the
-- subtopic-grain reverse matcher. Nullable, no backfill: rows fill on the next ReciterAI
-- reproject (ReciterAI's backfill_rel already populated the GRANT# items).
ALTER TABLE `opportunity`
  ADD COLUMN `match_rel` JSON NULL;
