-- CreateTable
-- ORCID iDs RPM (ReCiter Publication Manager) holds for a scholar that SPS does not treat as
-- asserted: `rpm_inferred` (seen on the person's PubMed author record across articles they
-- accepted; articles_accepted / articles_rejected are the support) or `rpm_admin` (hand-entered
-- by an RPM administrator). Mirrored nightly by etl/orcid-candidates; consumed only by
-- /edit/orcid-coverage. `source` is part of the key: a second mirror (etl/orcid-registry,
-- weekly, the public ORCID registry) writes its own `orcid_*` sources into the same table, and
-- the same (cwid, orcid) seen by both must be two rows, never one overwriting the other. Additive.
CREATE TABLE `orcid_candidate` (
  `cwid` VARCHAR(32) NOT NULL,
  `orcid` VARCHAR(19) NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `articles_accepted` INTEGER NOT NULL DEFAULT 0,
  `articles_rejected` INTEGER NOT NULL DEFAULT 0,
  `source_updated_at` DATETIME(3) NULL,
  `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `orcid_candidate_source_idx`(`source`),
  PRIMARY KEY (`cwid`, `orcid`, `source`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `orcid_candidate` ADD CONSTRAINT `orcid_candidate_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
