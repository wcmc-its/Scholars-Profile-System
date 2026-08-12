-- AlterTable
-- A curator can manually attach a disease code the generator never suggested
-- (no `CancerCenterDiseaseAssignment` row for the pair); that decision has no
-- evidence to snapshot, so `score_at_decision` / `confidence_at_decision` must
-- allow NULL instead of a fake sentinel.
ALTER TABLE `cancer_center_disease_decision` MODIFY `score_at_decision` INTEGER NULL,
    MODIFY `confidence_at_decision` VARCHAR(16) NULL;
