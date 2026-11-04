-- Matcha: an editable requester for saved searches.
--
-- The extractor now returns `requester` (who is asking) alongside a focus-only
-- `titleSummary`, and the title reads "{requester} — {focus}". The model's
-- requester rides the stored `result` JSON; `requester_override` is the
-- officer's correction, kept apart from it so clearing the override restores
-- the model's. Like `title_override`, it is written on every row of a
-- `description_hash` in the caller's scope. Not audited (Rename is not).

-- AlterTable
ALTER TABLE `sponsor_match_submission`
    ADD COLUMN `requester_override` VARCHAR(120) NULL;
