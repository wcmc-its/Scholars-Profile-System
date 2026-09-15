-- CWIDs with an EXPIRED faculty-SOR role record that still says something
-- about career stage: `professor` (any professor-ranked title — excluded from
-- mentee suggestions) or `fellow` / `postdoc` (a departed trainee — suggested
-- under that kind). Rewritten nightly by etl:ed; read by the mentee-suggestion
-- builder (etl:reciter).

CREATE TABLE `former_faculty_role` (
    `cwid` VARCHAR(32) NOT NULL,
    `role` VARCHAR(16) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The builder no longer writes unknown-tier rows (co-authors with no trainee
-- signal). Clear the ones already stored so the nightly's stale-pair prune
-- (volume-guarded at 20%) doesn't refuse the first run under the new rule.
DELETE FROM `mentee_suggestion` WHERE `tier` = 'unknown';
