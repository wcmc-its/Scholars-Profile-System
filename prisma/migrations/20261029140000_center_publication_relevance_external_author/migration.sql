-- Inter-institutional flag for the collaborative publication matrix, written by
-- etl/center-pub-relevance from PubMed author affiliations. Additive DDL only.

-- AlterTable
ALTER TABLE `center_publication_relevance` ADD COLUMN `external_author` BOOLEAN NULL;
