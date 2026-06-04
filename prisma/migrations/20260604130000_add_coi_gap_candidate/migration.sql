-- Phase 1 (COI-gap) — persisted, disavow-able candidate store.
--
-- One row per (cwid, pmid, normalized entity) where a relationship named in the
-- scholar's own PubMed COI statement was NOT found in their disclosed set. The
-- daily `etl:coi-gap` job upserts these incrementally (only scholars whose
-- statements/disclosures changed). Persisting — rather than computing ephemerally
-- — lets the scholar DISAVOW a bad match (status='dismissed') durably so the same
-- nudge never recurs, and lets us track the lifecycle (new/acknowledged/
-- dismissed/resolved) without re-retrieving from PubMed.
--
-- GOVERNANCE (docs/coi-pubmed-unmatched-feasibility.md): candidate + scholar's
-- own review status, NOT a verdict. No "undisclosed" boolean, no ranking; shown
-- ONLY to the scholar themselves (self-only) — never curators/superusers/public
-- or any compliance feed. Additive: new table FK-cascaded to scholar, no change
-- to existing tables.

-- CreateTable
CREATE TABLE `coi_gap_candidate` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `entity` VARCHAR(512) NOT NULL,
    `normalized_entity` VARCHAR(512) NOT NULL,
    `tier` VARCHAR(16) NOT NULL,
    `attribution` VARCHAR(32) NOT NULL,
    `entity_score` DECIMAL(4, 3) NULL,
    `category` VARCHAR(16) NOT NULL,
    `source_sentence` TEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'new',
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewed_at` DATETIME(3) NULL,

    INDEX `coi_gap_candidate_cwid_status_idx`(`cwid`, `status`),
    UNIQUE INDEX `coi_gap_candidate_cwid_pmid_normalized_entity_key`(`cwid`, `pmid`, `normalized_entity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `coi_gap_candidate` ADD CONSTRAINT `coi_gap_candidate_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
