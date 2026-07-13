-- Purely additive: a new table, no change to any existing one, so nothing to
-- backfill and nothing that an older app image can trip over (it simply never
-- writes here).
--
-- `description` is TEXT because a sponsor email regularly runs to a few thousand
-- characters; the app truncates its ENGINE INPUT at 3,000 chars, but what is
-- stored is the officer's paste in full — the point of keeping it is to have the
-- real text, not the ranker's view of it.
--
-- `description_hash` is NOT unique. The same paste re-submitted after a nightly
-- reindex is a genuinely different search with a genuinely different answer, and
-- collapsing the two would erase the record of when a result changed.
CREATE TABLE `sponsor_match_submission` (
  `id` VARCHAR(64) NOT NULL,
  `description` TEXT NOT NULL,
  `description_hash` VARCHAR(64) NOT NULL,
  `title` VARCHAR(512) NULL,
  `engine` VARCHAR(16) NOT NULL,
  `candidate_count` INTEGER NOT NULL,
  `submitted_by` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `sponsor_match_submission_created_at_idx`(`created_at`),
  INDEX `sponsor_match_submission_submitted_by_idx`(`submitted_by`),
  INDEX `sponsor_match_submission_description_hash_idx`(`description_hash`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
