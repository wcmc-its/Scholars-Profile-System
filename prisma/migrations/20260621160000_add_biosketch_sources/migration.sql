-- AlterTable
-- #917 v6 follow-up -- per-contribution source PMIDs for output traceability. Additive +
-- nullable; sits alongside `products`.
ALTER TABLE `biosketch_generation`
  ADD COLUMN `sources` JSON NULL;
