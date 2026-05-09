-- Adds RePORTER-sourced fields to `grant`. Populated by etl/reporter/index.ts
-- which reads from reciterdb.grant_reporter_project (kept in sync nightly by
-- ReCiterDB's retrieveReporter.py — see issue #85).
--
-- abstract_text comes from RePORTER's /projects/search; appl_id is the most
-- recent NIH application ID matching the grant's core_project_num. Both
-- nullable: only NIH grants populate them. Non-NIH (industry, internal,
-- foundation) Grants stay null forever.

-- AlterTable
ALTER TABLE `grant`
  ADD COLUMN `appl_id`              INT          NULL,
  ADD COLUMN `abstract`             TEXT         NULL,
  ADD COLUMN `abstract_fetched_at`  DATETIME(3)  NULL;

-- CreateIndex
CREATE INDEX `grant_appl_id_idx` ON `grant`(`appl_id`);
