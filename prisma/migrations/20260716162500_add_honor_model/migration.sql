-- Honors and distinctions (#1760) — academy memberships, investigatorships,
-- named chairs, and prizes, entered by a curator (or a scholar on their own
-- profile) on /edit. Modelled on `profile_appointment`: a SEPARATE table no ETL
-- truncates (structurally wipe-safe), FK-cascaded to scholar, and profile-only
-- by construction — no center/department/division/search serializer reads it,
-- so an honor can never leak onto an aggregate page. Additive: a new table, no
-- change to any existing one, so nothing to backfill and nothing an older app
-- image can trip over (it simply never writes here).
--
-- `name` and `organization` are free text. The conferring body is deliberately
-- NOT constrained to a vocabulary: the long tail of societies is the point, and
-- a closed list would silently drop the honors it doesn't yet know.
--
-- `status` defaults to 'published' because curator/self entry IS the human
-- confirmation. The Phase 3 roster feed writes 'pending' explicitly for a human
-- to confirm — the sweep never auto-publishes. 'rejected' is terminal so a
-- re-run of the feed does not re-propose a row a human already turned down.
--
-- `source_ref` (the roster URL a fed row came from) is VARCHAR(512), matching
-- every other URL column in this schema; NULL for hand-entered rows.

-- CreateTable
CREATE TABLE `honor` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `category` ENUM('ACADEMY_MEMBERSHIP', 'INVESTIGATORSHIP', 'PRIZE', 'OTHER') NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `organization` VARCHAR(255) NOT NULL,
    `year` INTEGER NULL,
    `status` ENUM('published', 'pending', 'rejected') NOT NULL DEFAULT 'published',
    `show_on_profile` BOOLEAN NOT NULL DEFAULT true,
    `source` VARCHAR(32) NOT NULL DEFAULT 'CURATOR',
    `source_ref` VARCHAR(512) NULL,
    `entered_by_cwid` VARCHAR(32) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `honor_cwid_status_show_on_profile_idx`(`cwid`, `status`, `show_on_profile`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `honor` ADD CONSTRAINT `honor_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
