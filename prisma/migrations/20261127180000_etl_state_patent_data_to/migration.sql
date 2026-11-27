-- The date the loaded PatentsView tables run to. Written by
-- etl:patent-citations:refresh after each load; read by report 25, the
-- Bibliometrics patents card and both patent downloads. NULL until the first
-- refresh, when readers fall back to 2025-12-31 (the 2026-11-26 load).

-- AlterTable
ALTER TABLE `etl_state` ADD COLUMN `patent_data_to` DATE NULL;
