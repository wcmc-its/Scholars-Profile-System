-- Department.category — Browse-page grouping bucket.
-- Hand-curated via lib/department-categories.ts; the ED ETL preserves existing
-- values rather than overwriting (manual reclassification persists). Display
-- label mapping ("mixed" → "Basic & Clinical") happens at the UI layer.

-- AlterTable
ALTER TABLE `department` ADD COLUMN `category` VARCHAR(32) NOT NULL DEFAULT 'clinical';
