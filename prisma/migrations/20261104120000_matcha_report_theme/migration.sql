-- Matcha report v2: themes for the scouting report's coverage table.
--
-- `matcha_report_theme` holds one grouping of a paste's stored concept terms
-- into at most six labelled themes. Keyed on the paste's `description_hash`
-- (the same digest as `sponsor_match_submission` and `matcha_brief`, no FK for
-- the same reason) plus `concepts_hash`, the sha256 of the sorted concept terms,
-- so a stored result with a different concept set gets its own row.
--
-- `themes` is `[{label, terms[]}]`, validated before it is written; a failed or
-- invalid model call writes nothing. No audit row: the report is read-only.

-- CreateTable
CREATE TABLE `matcha_report_theme` (
    `id` VARCHAR(64) NOT NULL,
    `description_hash` VARCHAR(64) NOT NULL,
    `concepts_hash` VARCHAR(64) NOT NULL,
    `themes` JSON NOT NULL,
    `model` VARCHAR(64) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `matcha_report_theme_description_hash_concepts_hash_key`(`description_hash`, `concepts_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
