-- Where in an NCBI Bookshelf document a WCM publication is cited: the chapters
-- and sections NCBI reports, as `[{ url, label }]`, so the publication modal
-- can link to the place and not the book's front page. Filled by
-- etl:policy-citations on its next Bookshelf pass; NULL for PubMed documents.

-- AlterTable
ALTER TABLE `publication_citing_document`
    ADD COLUMN `locations` JSON NULL;
