-- Clinical articles that cite a WCM publication (iCite's clinical flag, from
-- reciterdb `analysis_nih_cites_clin`), stored as citing documents (`source`
-- 'pubmed', `level` 'clinical'; both columns are VARCHAR(16), so no column
-- change for the new value). Loaded by etl:clinical-citations.
--
-- `publication_citing_document.evidence`: `{ "ownWork": true }` when the citing
-- article is one of ours and shares a confirmed WCM author with the paper.
-- `publication.clinical_cite_count`: citing clinical articles, less the
-- authors' own. 0 until the first load. Nothing reads it yet.

-- AlterTable
ALTER TABLE `publication`
    ADD COLUMN `clinical_cite_count` INTEGER NOT NULL DEFAULT 0;
