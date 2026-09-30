-- Lands the method-family + MeSH-descriptor evidence the cores inference engine
-- (`pipeline_cores`) has started emitting on its PUB#/CORE# DynamoDB items,
-- alongside the five signals already projected here.
--
--   method_tier     - family-strength band: "strong" | "moderate" | "weak".
--   method_evidence - the ranked list behind that tier (strongest first),
--                     [{ family, tool, sentence }]; written together with
--                     method_tier or not at all.
--   mesh_evidence   - [{ descriptor_ui, descriptor, tree_prefix }], written
--                     independently of the method pair.
--
-- JSON columns rather than a child table, the precedent `signal_coauthors` set
-- on this table: the read path only ever wants the whole list for one
-- (pmid, core_id) pair.
--
-- Additive only, all nullable, no backfill and no index: every existing row was
-- scored before the engine emitted these, so all three stay NULL until the next
-- upstream run. Nothing renders them yet.
ALTER TABLE `publication_core`
  ADD COLUMN `method_tier` VARCHAR(16) NULL,
  ADD COLUMN `method_evidence` JSON NULL,
  ADD COLUMN `mesh_evidence` JSON NULL;
