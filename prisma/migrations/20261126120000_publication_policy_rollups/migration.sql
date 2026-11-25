-- Three more guideline and policy citation rollups on `publication`, beside
-- `guideline_count` and `review_count`: distinct authority documents, distinct
-- consensus statements, and the newest citing document's year. The /edit
-- report "Guideline and policy citations" reads them so it does not aggregate
-- 390,000 citation links on every page load. Filled by etl:policy-citations
-- (its rollup step) on its next run; 0 / NULL until then.
--
-- The index covers the report's read: the cited publications are a small share
-- of a wide table, and without it that read is a full table scan.

-- AlterTable
ALTER TABLE `publication`
    ADD COLUMN `authority_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `consensus_count` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `latest_citing_year` INTEGER NULL;

-- CreateIndex
CREATE INDEX `publication_policy_rollup_idx` ON `publication`(`authority_count`, `guideline_count`, `consensus_count`, `review_count`, `latest_citing_year`);
