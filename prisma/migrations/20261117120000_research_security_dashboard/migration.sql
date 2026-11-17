-- Research security dashboard (/edit/research-security). A denormalized copy of
-- reciterdb's watch-list screen joined to current authorship, replaced in full
-- each night by etl/research-security. Additive: four new tables, nothing else
-- is touched. Sensitive and per-person; read only by that page and its export.

-- CreateTable
CREATE TABLE `research_security_article` (
    `article_id` VARCHAR(96) NOT NULL,
    `pmid` INTEGER NULL,
    `title` TEXT NULL,
    `journal` VARCHAR(512) NULL,
    `publication_date` DATE NULL,
    `publication_type` VARCHAR(128) NULL,
    `total_authors` INTEGER NOT NULL DEFAULT 0,
    `doi` VARCHAR(255) NULL,
    `source` VARCHAR(16) NOT NULL,
    `last_refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `research_security_article_publication_date_idx`(`publication_date`),
    PRIMARY KEY (`article_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `research_security_person` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` VARCHAR(96) NOT NULL,
    `cwid` VARCHAR(32) NULL,
    `display_name` VARCHAR(255) NOT NULL,
    `first_name` VARCHAR(128) NULL,
    `last_name` VARCHAR(128) NULL,
    `campus` VARCHAR(8) NOT NULL,
    `department` VARCHAR(255) NULL,
    `title` VARCHAR(255) NULL,
    `attribution` VARCHAR(16) NOT NULL,
    `in_review_queue` BOOLEAN NOT NULL DEFAULT false,
    `reciter_score` DOUBLE NULL,

    INDEX `research_security_person_article_id_idx`(`article_id`),
    INDEX `research_security_person_cwid_idx`(`cwid`),
    INDEX `research_security_person_attribution_idx`(`attribution`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `research_security_match` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `article_id` VARCHAR(96) NOT NULL,
    `list_code` VARCHAR(40) NOT NULL,
    `category` VARCHAR(64) NOT NULL,
    `list_no` INTEGER NULL,
    `entity` VARCHAR(160) NOT NULL,
    `author_rank` INTEGER NOT NULL,
    `author_name` VARCHAR(255) NULL,
    `affiliation` TEXT NULL,
    `is_institution_author` BOOLEAN NOT NULL DEFAULT false,
    `our_author_cwids` VARCHAR(512) NULL,

    INDEX `research_security_match_article_id_idx`(`article_id`),
    INDEX `research_security_match_list_code_entity_idx`(`list_code`, `entity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `research_security_funding_flag` (
    `article_id` VARCHAR(96) NOT NULL,
    `program` VARCHAR(160) NOT NULL,
    `agency` VARCHAR(500) NULL,
    `grant_id` VARCHAR(255) NULL,

    PRIMARY KEY (`article_id`, `program`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `research_security_person` ADD CONSTRAINT `research_security_person_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `research_security_article`(`article_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `research_security_match` ADD CONSTRAINT `research_security_match_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `research_security_article`(`article_id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `research_security_funding_flag` ADD CONSTRAINT `research_security_funding_flag_article_id_fkey` FOREIGN KEY (`article_id`) REFERENCES `research_security_article`(`article_id`) ON DELETE CASCADE ON UPDATE CASCADE;
