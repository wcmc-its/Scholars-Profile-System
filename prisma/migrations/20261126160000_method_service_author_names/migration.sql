-- Method services: name the unit's authors.
--
-- `author_names`: the unit's authors as PubMed lists them, each "family name
-- then first initial", entered by a superuser. A supported publication is a
-- collaboration when one of its PubMed authors has that family name and first
-- initial, as it already is when an author's affiliation contains one of the
-- service's `affiliation_phrases`. Names catch the people whose affiliation is
-- written another way on a given paper.
-- `name_matched_pmids`: the PMIDs in `coauthored_pmids` that were found by an
-- author name and not by an affiliation, kept only so the editor's review list
-- can say why. Written by the app when a service is saved; never by hand and
-- never by an ETL.
--
-- Additive. Both default to an empty list, which is what an existing row gets:
-- with no names, nothing changes for it until a superuser adds one and saves.
-- The column default also covers an insert from an app task still on the
-- previous image while a deploy rolls.

-- AlterTable
ALTER TABLE `method_service`
    ADD COLUMN `author_names` JSON NOT NULL DEFAULT (JSON_ARRAY()),
    ADD COLUMN `name_matched_pmids` JSON NOT NULL DEFAULT (JSON_ARRAY());
