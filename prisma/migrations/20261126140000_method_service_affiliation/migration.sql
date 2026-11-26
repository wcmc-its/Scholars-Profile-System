-- Method services: tell a collaboration from support.
--
-- `affiliation_phrases`: short strings a superuser enters that identify the
-- unit's authors in a PubMed affiliation (a library's name, say).
-- `coauthored_pmids`: the service's supported PMIDs with an author whose
-- PubMed affiliation contains one of those phrases. Written by the app when a
-- service is saved; never by hand and never by an ETL.
--
-- Additive. Both default to an empty list, which is what an existing row gets:
-- with no phrases, nothing on its supported list is a collaboration by
-- affiliation until a superuser adds a phrase and saves. The column default
-- also covers an insert from an app task still on the previous image while a
-- deploy rolls.

-- AlterTable
ALTER TABLE `method_service`
    ADD COLUMN `affiliation_phrases` JSON NOT NULL DEFAULT (JSON_ARRAY()),
    ADD COLUMN `coauthored_pmids` JSON NOT NULL DEFAULT (JSON_ARRAY());
