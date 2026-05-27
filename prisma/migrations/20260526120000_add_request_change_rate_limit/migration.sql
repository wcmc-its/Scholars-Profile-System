-- Per-cwid rate limit for the "Request a change" server send (#160 Phase 2,
-- docs/self-edit-request-change-modal.md § 5 abuse controls).
--
-- A fixed 1-hour window keyed on (cwid, window_start). The application
-- increments via `INSERT ... ON DUPLICATE KEY UPDATE count = count + 1`
-- (lib/edit/rate-limit.ts), which is atomic on the primary-key row lock —
-- Prisma `upsert` is a read-then-write and would double-count two concurrent
-- requests for the same cwid, precisely the adversary a rate limit must hold
-- against. Rows accrete one per cwid per active hour; the volume is negligible
-- and stale windows can be pruned out-of-band.
--
-- The table lives in the main application schema, so the app role's existing
-- DML grant already covers it — there is no separate-schema GRANT to apply by
-- hand at deploy time (the failure mode that currently 500s Hide/Show, #493).

-- CreateTable
CREATE TABLE `request_change_rate_limit` (
    `cwid` VARCHAR(32) NOT NULL,
    `window_start` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`cwid`, `window_start`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
