-- The WCM affiliation matcher (lib/edit/pubmed-affiliations.ts) narrowed to
-- Weill Cornell Medicine only: NewYork-Presbyterian and Cornell University
-- (Ithaca) now count as outside WCM. Clear the flags the old matcher wrote so
-- etl/center-pub-relevance asks PubMed again for every relevant row (it looks
-- up rows where external_author IS NULL). Data only; no DDL.
UPDATE `center_publication_relevance` SET `external_author` = NULL WHERE `external_author` IS NOT NULL;
