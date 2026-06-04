-- Phase 1 (COI-gap) — per-PMID PubMed competing-interest statement store.
--
-- One row per publication carrying a non-empty COI ("Competing interests:")
-- statement, backfilled from `reciterdb.reporting_conflicts.conflictsVarchar`
-- by `etl/reciter/backfill-coi-statements.ts`. The text is PAPER-LEVEL (shared
-- by all co-authors of the PMID); the per-author attribution that decides
-- whether a named relationship belongs to a given scholar is computed at request
-- time by `lib/coi-gap` and never persisted as a verdict — see
-- docs/coi-pubmed-unmatched-feasibility.md.
--
-- Additive: a new sparse table keyed 1:1 to `publication` (avoids widening the
-- hot publication row and keeps this sensitive text isolated). FK cascades on
-- publication delete. No change to existing tables.

-- CreateTable
CREATE TABLE `publication_conflict_statement` (
    `pmid` VARCHAR(32) NOT NULL,
    `statement_text` TEXT NOT NULL,
    `source` VARCHAR(32) NOT NULL DEFAULT 'PubMed',
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `publication_conflict_statement` ADD CONSTRAINT `publication_conflict_statement_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;
