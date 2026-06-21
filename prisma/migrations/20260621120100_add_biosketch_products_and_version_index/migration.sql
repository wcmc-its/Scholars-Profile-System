-- AlterTable
-- #917 v6 -- the Products list (Contributions mode) persisted alongside the entries, and a
-- (prompt_version, created_at) index for A/B history queries. Additive + nullable.
ALTER TABLE `biosketch_generation`
  ADD COLUMN `products` JSON NULL;

-- CreateIndex
CREATE INDEX `biosketch_generation_prompt_version_created_at_idx`
  ON `biosketch_generation` (`prompt_version`, `created_at` DESC);
