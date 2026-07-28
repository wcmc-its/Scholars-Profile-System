-- #2020 — two additions, both concerning InfoEd awards that carry no project
-- period on any of their records.
--
-- `etl/infoed` drops rows with a null start or end date, because `grant`'s date
-- columns are NOT NULL and the active/expired split, `isRecentlyCompleted` and
-- every recency signal key on them. Measured 2026-07-28: that drop is 4,244 of
-- 17,954 eligible (cwid, account) pairs, ~850 of which carry a sponsor award
-- number — funded awards rendering nowhere, 159 of them ACTIVE.
--
-- 1. `grant.dates_source` — provenance of the period, NOT of the grant (that is
--    `grant.source`). Existing rows all took their period from InfoEd's own
--    app_st_dt/app_end_dt, so the 'infoed' default is a correct backfill and
--    nothing needs rewriting. An older app image ignores the column entirely.
--
-- 2. `grant_date_gap` — the worklist for OSRA. Additive: a new table, nothing
--    to backfill, invisible to an older image. Modelled on `coi_gap_candidate`:
--    a lifecycle (open -> backfilled / resolved / dismissed) with `first_seen_at`
--    and durable dismissals, because a list that re-proposes rows a human
--    already judged is a list nobody reads.
--
--    `backfilled` is an OPEN state on purpose. A RePORTER-derived period makes
--    the grant render; it does not make the InfoEd record correct, and ~124
--    active non-NIH awards can only ever be fixed at the source.
--
--    No FK to `grant` — the whole point is that no `grant` row exists, or that
--    it exists on a derived period while the source is still wrong.

-- AlterTable
ALTER TABLE `grant` ADD COLUMN `dates_source` VARCHAR(16) NOT NULL DEFAULT 'infoed';

-- CreateTable
CREATE TABLE `grant_date_gap` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `account_number` VARCHAR(64) NOT NULL,
    `external_id` VARCHAR(128) NOT NULL,
    `award_number` VARCHAR(128) NULL,
    `sponsor` VARCHAR(255) NULL,
    `project_status` VARCHAR(64) NOT NULL,
    `program_type` VARCHAR(64) NOT NULL,
    `unit_name` VARCHAR(255) NULL,
    `missing_field` VARCHAR(8) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'open',
    `backfill_source` VARCHAR(16) NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `resolved_at` DATETIME(3) NULL,
    `dismissed_at` DATETIME(3) NULL,
    `dismissed_by` VARCHAR(32) NULL,
    `dismissal_reason` VARCHAR(255) NULL,

    UNIQUE INDEX `grant_date_gap_external_id_key`(`external_id`),
    INDEX `grant_date_gap_status_project_status_idx`(`status`, `project_status`),
    INDEX `grant_date_gap_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `grant_date_gap` ADD CONSTRAINT `grant_date_gap_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
