-- CreateTable
-- Open reciterdb `authorship_review` rows per byline ORCID iD (bare form, CHAR(19)):
-- how many candidate authorships awaiting a curator carry each iD. Full-replaced
-- nightly by etl/orcid-authorship-impact; read only by /edit/orcid-coverage, which
-- joins it to people through scholar.orcid and orcid_candidate (no cwid here).
-- Additive; empty until the first run, and the page shows nothing while it is empty.
CREATE TABLE `orcid_open_authorship` (
  `orcid` CHAR(19) NOT NULL,
  `open_rows` INTEGER NOT NULL,
  `refreshed_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`orcid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
