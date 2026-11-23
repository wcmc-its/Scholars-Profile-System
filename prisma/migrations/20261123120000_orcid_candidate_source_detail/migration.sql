-- AlterTable
-- Where a web_page_seed candidate's evidence came from ("Cornell profile, lab site and CV"):
-- web seeds step 3 reads lab / personal sites and CVs too, so "Cornell web page" is no longer
-- always true. Nullable, additive; only web_page_seed rows set it.
ALTER TABLE `orcid_candidate` ADD COLUMN `source_detail` VARCHAR(100) NULL;
