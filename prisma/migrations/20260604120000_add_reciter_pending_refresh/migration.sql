-- Durable intent for the self-edit "Not mine" reject → ReCiter flow (#746).
--
-- One row per rejected (uid, pmid). The reject route writes the row in the same
-- transaction as the local suppression + B03 audit row, then best-effort fires
-- the ReCiter goldstandard POST and stamps `goldstandard_sent_at` on success.
-- The `etl/reciter-refresh` scanner is the durable backstop: it retries any row
-- whose `goldstandard_sent_at` is still NULL, and — once a uid's rejects are
-- older than the delay window — fires ONE coalesced feature-generator re-score
-- per uid and stamps `feature_generator_sent_at`. This mirrors the ADR-005
-- layer-3 sentinel/reconciler pattern (#393): a NULL timestamp means "not yet
-- delivered", and the scanner converges it.
--
-- Lives in the main application schema so the app role's existing DML grant
-- already covers it (no separate-schema GRANT to apply by hand at deploy time —
-- the failure mode that 500s Hide/Show, #493).

-- CreateTable
CREATE TABLE `reciter_pending_refresh` (
    `id` VARCHAR(64) NOT NULL,
    `uid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `rejected_by` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `goldstandard_sent_at` DATETIME(3) NULL,
    `feature_generator_sent_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Scanner predicates: "goldstandard not yet sent" and "uid re-score pending".
CREATE INDEX `reciter_pending_refresh_goldstandard_sent_at_idx`
    ON `reciter_pending_refresh` (`goldstandard_sent_at`);
CREATE INDEX `reciter_pending_refresh_uid_feature_generator_sent_at_idx`
    ON `reciter_pending_refresh` (`uid`, `feature_generator_sent_at`);
