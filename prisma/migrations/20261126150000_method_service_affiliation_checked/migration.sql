-- Method services: remember which supported PMIDs PubMed has been asked about.
--
-- `affiliation_checked_pmids`: the service's supported PMIDs whose author
-- affiliations have been read from PubMed and compared with the service's
-- current `affiliation_phrases`. `coauthored_pmids` is the subset that matched.
-- A long supported list cannot be read from PubMed inside one save request, so
-- each save reads what it can before its deadline, records it here, and the
-- next save asks only for the rest. Written by the app when a service is
-- saved; never by hand and never by an ETL.
--
-- Additive. Defaults to an empty list: an existing row is simply read from
-- PubMed in full the next time it is saved with a phrase. The column default
-- also covers an insert from an app task still on the previous image while a
-- deploy rolls.

-- AlterTable
ALTER TABLE `method_service`
    ADD COLUMN `affiliation_checked_pmids` JSON NOT NULL DEFAULT (JSON_ARRAY());
