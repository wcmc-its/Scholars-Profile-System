-- Undo for the news / media highlights review queues. Each /edit queue decision
-- stamps every row it writes with its request id and the row's pre-decision
-- state, so POST /api/edit/news-mention/undo can put them back. prev_status NULL
-- with decision_id set marks a row the decision CREATED (a "wrong person"
-- reassign), which undo deletes. All nullable, no backfill: existing rows simply
-- have nothing to undo.
ALTER TABLE `news_mention`
    ADD COLUMN `decision_id` VARCHAR(64) NULL,
    ADD COLUMN `decision_at` DATETIME(3) NULL,
    ADD COLUMN `prev_status` ENUM('published', 'pending', 'rejected') NULL,
    ADD COLUMN `prev_show_on_profile` BOOLEAN NULL,
    ADD COLUMN `prev_entered_by_cwid` VARCHAR(32) NULL;
CREATE INDEX `news_mention_decision_id_idx` ON `news_mention`(`decision_id`);
