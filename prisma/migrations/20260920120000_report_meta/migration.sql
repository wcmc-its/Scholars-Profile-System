-- Report metadata for the /edit/reports console — one row per numbered
-- report (`report_key` '1'..'7'): the NAME shown in the index and the page
-- <h1> (without its "N. " prefix), the one-line SUMMARY the index card shows,
-- an optional rich-text DESCRIPTION (sanitized HTML, the overview allowlist)
-- rendered as a closed "About this report" disclosure on the page, and the
-- SLUG the report will be addressed by (`/edit/reports/<slug>`; the number
-- stays the stable key and redirects to the slug, so a slug can be renamed).
-- Editable in-app by a superuser (app/api/edit/report-meta/[n]). DDL only —
-- no seed rows (#584: migrations never INSERT). Today's names, blurbs and
-- report 7's description (the former hardcoded "Sources" disclosure) live in
-- lib/edit/report-meta.ts (`REPORT_META_DEFAULTS`), the fallback for a report
-- with no row; a row, once a superuser saves one, wins entirely.

CREATE TABLE `report_meta` (
    `report_key` VARCHAR(64) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `description_html` TEXT NULL,
    `updated_by` VARCHAR(32) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `report_meta_slug_key`(`slug`),
    PRIMARY KEY (`report_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
