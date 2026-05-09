-- Issue #89 — Vancouver citation completeness. volume/issue/pages from
-- analysis_summary_article; journal_abbrev from
-- person_article.journalTitleISOabbreviation (despite the name, the
-- values are NLM-style abbreviations like "Proc Natl Acad Sci U S A").

ALTER TABLE `publication`
  ADD COLUMN `volume` VARCHAR(64) NULL,
  ADD COLUMN `issue` VARCHAR(64) NULL,
  ADD COLUMN `pages` VARCHAR(64) NULL,
  ADD COLUMN `journal_abbrev` VARCHAR(200) NULL;
