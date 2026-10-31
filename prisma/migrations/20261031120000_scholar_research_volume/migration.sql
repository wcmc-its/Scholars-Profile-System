-- Research type facet: per-scholar first/last-author research-article counts
-- over the last 5 years, split by NIH iCite triangle (lib/research-type.ts).
-- Written by the reciter ETL; NULL until its first run (NULL = not computed).
ALTER TABLE `scholar`
    ADD COLUMN `lab_pubs_5y` INTEGER NULL,
    ADD COLUMN `clinical_pubs_5y` INTEGER NULL;
