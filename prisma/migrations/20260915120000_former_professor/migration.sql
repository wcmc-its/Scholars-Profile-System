-- CWIDs with an EXPIRED professor-ranked faculty appointment in the ED faculty
-- SOR. Rewritten nightly by etl:ed; read by the mentee-suggestion builder
-- (etl:reciter) to drop former professors from the co-author candidate set.

CREATE TABLE `former_professor` (
    `cwid` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`cwid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
