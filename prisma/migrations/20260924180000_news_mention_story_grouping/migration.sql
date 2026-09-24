-- Media highlights story grouping: a clip row that is another copy of a story
-- points at the lead row (`duplicate_of`); `credited_outlet` holds the digest's
-- "originally appeared in X" credit, used to pick the lead. Both nullable, no FK.
ALTER TABLE `news_mention`
    ADD COLUMN `duplicate_of` VARCHAR(64) NULL,
    ADD COLUMN `credited_outlet` VARCHAR(255) NULL;
CREATE INDEX `news_mention_duplicate_of_idx` ON `news_mention`(`duplicate_of`);
