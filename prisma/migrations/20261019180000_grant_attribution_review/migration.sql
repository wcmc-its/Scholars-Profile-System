-- #3071 grant attribution scoring. Additive DDL only: two new tables that
-- nothing reads until the image that writes them ships (etl/reporter-grants,
-- etl/reciter, /edit/grant-attribution-queue).

-- CreateTable
-- One curator review per RePORTER award the scorer queued.
CREATE TABLE `grant_attribution_review` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `grant_external_id` VARCHAR(64) NOT NULL,
    `score` INTEGER NOT NULL,
    `band` VARCHAR(8) NOT NULL,
    `cues` JSON NOT NULL,
    `evidence_key` VARCHAR(255) NOT NULL,
    `award` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `decided_by_cwid` VARCHAR(32) NULL,
    `decided_at` DATETIME(3) NULL,
    `rejection_reason` VARCHAR(255) NULL,
    `decision_effects` JSON NULL,
    `reopened_at` DATETIME(3) NULL,
    `scored_at` DATETIME(3) NOT NULL,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `grant_attribution_review_grant_external_id_key`(`grant_external_id`),
    INDEX `grant_attribution_review_status_cwid_idx`(`status`, `cwid`),
    INDEX `grant_attribution_review_cwid_idx`(`cwid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
-- ReCiter "not me" rejections, mirrored from reciterdb by etl/reciter.
CREATE TABLE `reciter_rejected_pmid` (
    `cwid` VARCHAR(32) NOT NULL,
    `pmid` VARCHAR(32) NOT NULL,
    `synced_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`cwid`, `pmid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `grant_attribution_review` ADD CONSTRAINT `grant_attribution_review_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
