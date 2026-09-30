-- Mentored publications report (/edit/reports/7), round 5.

-- AlterTable
-- The two mentoring-bridge publication tables key on the SPS `Publication.pmid`
-- string instead of an integer pmid: the PubMed id as digits ("39887654") or
-- the source-prefixed article id ("SCOPUS:105037533819") for a Scopus-only
-- article, whose ReciterDB pmid is a synthetic negative that churns nightly and
-- which both importers used to drop. Both columns sit inside a composite
-- primary key, which MySQL rebuilds in place; the existing integer values
-- convert to their decimal strings, so no data step is needed. Scopus rows
-- arrive with the next export + import.
ALTER TABLE `mentee_copublication_pub` MODIFY COLUMN `pmid` VARCHAR(32) NOT NULL;
ALTER TABLE `aoc_mentee_publication` MODIFY COLUMN `pmid` VARCHAR(32) NOT NULL;
