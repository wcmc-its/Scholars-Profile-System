-- Always-shown open comment on the feedback form.
ALTER TABLE `feedback_submission` ADD COLUMN `comment` VARCHAR(1000) NULL;
