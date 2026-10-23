-- ORCID librarian confirmation queue (docs/orcid-librarian-queue-spec.md). Additive DDL only:
-- two nullable scholar columns and two new tables that nothing reads until the image that writes
-- them ships (etl/orcid-evidence, /edit/orcid-queue).

-- AlterTable
-- Who confirmed `orcid`: self | proxy | librarian | email_verified (authenticated reserved for
-- #3115). NULL = the iD came from WCM Identity, or none on file. `orcid_confirmed_by` is the real
-- actor's cwid, or "ETL" for email_verified. Existing rows stay NULL.
ALTER TABLE `scholar` ADD COLUMN `orcid_confirm_method` VARCHAR(16) NULL,
    ADD COLUMN `orcid_confirmed_by` VARCHAR(32) NULL;

-- CreateTable
-- The evidence behind each ORCID candidate pair, full replace per weekly etl/orcid-evidence run.
CREATE TABLE `orcid_candidate_evidence` (
    `cwid` VARCHAR(32) NOT NULL,
    `orcid` VARCHAR(19) NOT NULL,
    `band` VARCHAR(16) NOT NULL,
    `inst_match` BOOLEAN NOT NULL,
    `email_verified` BOOLEAN NOT NULL,
    `name_agrees` BOOLEAN NOT NULL,
    `shared` INTEGER NOT NULL,
    `competitor` BOOLEAN NOT NULL,
    `competitor_cwids` JSON NOT NULL,
    `competitor_orcids` JSON NOT NULL,
    `works_total` INTEGER NOT NULL,
    `new_works` INTEGER NOT NULL,
    `new_works_sample` JSON NOT NULL,
    `record_modified_at` DATETIME(3) NULL,
    `computed_at` DATETIME(3) NOT NULL,

    INDEX `orcid_candidate_evidence_band_idx`(`band`),
    INDEX `orcid_candidate_evidence_orcid_idx`(`orcid`),
    PRIMARY KEY (`cwid`, `orcid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- A librarian's review sample for one queue band: one row per sampled pair, sharing `id`.
CREATE TABLE `orcid_queue_sample` (
    `id` VARCHAR(64) NOT NULL,
    `band` VARCHAR(16) NOT NULL,
    `started_by` VARCHAR(32) NOT NULL,
    `started_at` DATETIME(3) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `orcid` VARCHAR(19) NOT NULL,
    `decision` VARCHAR(16) NULL,
    `decided_by` VARCHAR(32) NULL,
    `decided_at` DATETIME(3) NULL,

    INDEX `orcid_queue_sample_band_started_at_idx`(`band`, `started_at`),
    INDEX `orcid_queue_sample_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`, `cwid`, `orcid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orcid_candidate_evidence` ADD CONSTRAINT `orcid_candidate_evidence_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `orcid_queue_sample` ADD CONSTRAINT `orcid_queue_sample_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
