-- Cores inference — projection tables for ReciterAI's WCM core-facility usage
-- engine (ReciterAI PR #245). Mirrors the topic projection (topic /
-- publication_topic) for a new "publication -> core facility" surface.
--
--   core             — WCM core-facility catalog. Unlike topics (seeded from the
--                      DynamoDB TAXONOMY# record) there is NO DynamoDB catalog
--                      record for cores; the cores ETL block seeds this table
--                      from the version-controlled CORE_CATALOG constant
--                      (etl/dynamodb/core-catalog.ts), a thin mirror of
--                      ReciterAI's config/core_dictionary.yaml.
--   publication_core — projected (publication x core) usage candidates, keyed on
--                      (pmid, core_id) with NO scholar dimension (core usage is a
--                      property of the publication, not a pub x scholar pair).
--                      The engine writes DynamoDB PUB#{pmid}/CORE#{core_id} items;
--                      etl/dynamodb/index.ts Block 6 lands them here. Human
--                      claims/rejections live in the ADR-005 manual-override
--                      layer (read-time precedence), never in this ETL-owned table.
--
-- Additive only: two new tables + their FKs. No existing object is altered.

-- CreateTable
CREATE TABLE `core` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `facility` VARCHAR(255) NULL,
    `owner_cwid` VARCHAR(32) NULL,
    `source` VARCHAR(64) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publication_core` (
    `pmid` VARCHAR(32) NOT NULL,
    `core_id` VARCHAR(32) NOT NULL,
    `likelihood` DECIMAL(5, 4) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `signal_coauthors` JSON NULL,
    `signal_ack` BOOLEAN NOT NULL DEFAULT false,
    `ack_alias` VARCHAR(255) NULL,
    `ack_snippet` TEXT NULL,
    `llm_score` SMALLINT NULL,
    `llm_rationale` TEXT NULL,
    `author_affinity` DECIMAL(5, 4) NULL,
    `scored_at` DATETIME(3) NOT NULL,

    INDEX `publication_core_core_id_likelihood_idx`(`core_id`, `likelihood` DESC),
    INDEX `publication_core_core_id_status_idx`(`core_id`, `status`),
    PRIMARY KEY (`pmid`, `core_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `publication_core` ADD CONSTRAINT `publication_core_pmid_fkey` FOREIGN KEY (`pmid`) REFERENCES `publication`(`pmid`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `publication_core` ADD CONSTRAINT `publication_core_core_id_fkey` FOREIGN KEY (`core_id`) REFERENCES `core`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
