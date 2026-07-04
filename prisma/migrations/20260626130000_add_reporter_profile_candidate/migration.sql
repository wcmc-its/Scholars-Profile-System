-- RePORTER grants v2 — the PMID-overlap matcher's proposal/adjudication ledger.
--
-- One row per candidate NIH eRA `profile_id` the v2 matcher (`etl/reporter-grants`
-- v2 branch, REPORTER_MATCH_V2=on) proposes for a scholar who has NO
-- `person_nih_profile` row yet — the lateral-recruit case v1 can't reach. K>=3
-- auto-locks (status=confirmed, reviewed_by='system-autolock'); K=2 lands pending
-- for an /edit "Is this you?" confirm. `confirmed`/`revoked` flip whether a
-- `person_nih_profile` row exists for (cwid, external_profile_id); `rejected` /
-- `revoked` are terminal so the matcher never re-proposes them.
--
-- Additive: one new table FK-cascaded to scholar; no change to existing tables.
-- Sits empty-and-dark until both the v2 ETL branch and REPORTER_MATCH_V2 land.
-- See docs/reporter-grants-v2-matcher-spec.md sections 4 and 5.

-- CreateTable
CREATE TABLE `reporter_profile_candidate` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `external_profile_id` INTEGER NOT NULL,
    `candidate_name` VARCHAR(255) NOT NULL,
    `candidate_orgs` VARCHAR(512) NOT NULL,
    `grant_count` INTEGER NOT NULL,
    `overlap_k` INTEGER NOT NULL,
    `sample_grants` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `reviewed_by` VARCHAR(32) NULL,
    `reviewed_at` DATETIME(3) NULL,
    `reject_reason` VARCHAR(24) NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reporter_profile_candidate_cwid_status_idx`(`cwid`, `status`),
    UNIQUE INDEX `reporter_profile_candidate_cwid_external_profile_id_key`(`cwid`, `external_profile_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `reporter_profile_candidate` ADD CONSTRAINT `reporter_profile_candidate_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
