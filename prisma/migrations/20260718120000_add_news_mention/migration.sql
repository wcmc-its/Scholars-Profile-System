-- News mentions — a scholar named in a WCM Research news article
-- (research.weill.cornell.edu/about-us/news-updates), scraped weekly by
-- etl/news. Modelled on `scholar_technology` (one scraped-WCM-site section,
-- article metadata denormalized per mention) but with `honor`'s review
-- discipline: a SEPARATE table no ETL truncates. The importer UPSERTS and
-- preserves human review state (approve/reject/hide) — a re-scrape must never
-- wipe a queue decision, so unlike scholar_technology this table is never
-- truncate-rebuilt. Additive: a new table, nothing to backfill, nothing an
-- older app image can trip over (it simply never writes here).
--
-- A (scholar, article) link is established one of two ways, carried in `source`:
--   'VIVO'  the article hyperlinks the scholar's VIVO profile
--           (vivo.weill.cornell.edu/display/cwid-<cwid>) — identifier join,
--           trusted, ingested straight to status='published'.
--   'NAME'  the article names the scholar in prose without a VIVO link; the ETL
--           matched the folded full name against `scholar`. Ingested as
--           status='pending' for review in /edit/news-queue. `detected_name`
--           holds the matched string, `likelihood` HIGH|MEDIUM, and `source_ref`
--           ('<url>|<detected_name>') groups the competing candidates when one
--           full name resolves to more than one scholar.
--   'CURATOR' reserved for manual entry.
--
-- `status` defaults to 'pending' because the untrusted NAME path is the common
-- ingest; the scraper sets 'published' explicitly for VIVO-linked rows.
-- 'rejected' is terminal so a re-scrape does not re-propose a row a human
-- already turned down. `source_ref` is VARCHAR(768) (not indexed) to hold a
-- 512-char url plus the joined name.

-- CreateTable
CREATE TABLE `news_mention` (
    `id` VARCHAR(64) NOT NULL,
    `cwid` VARCHAR(32) NOT NULL,
    `url` VARCHAR(512) NOT NULL,
    `title` TEXT NOT NULL,
    `published_at` DATETIME(3) NULL,
    `excerpt` TEXT NULL,
    `thumbnail_url` VARCHAR(512) NULL,
    `status` ENUM('published', 'pending', 'rejected') NOT NULL DEFAULT 'pending',
    `source` VARCHAR(32) NOT NULL DEFAULT 'VIVO',
    `detected_name` VARCHAR(255) NULL,
    `likelihood` VARCHAR(8) NULL,
    `source_ref` VARCHAR(768) NULL,
    `show_on_profile` BOOLEAN NOT NULL DEFAULT true,
    `entered_by_cwid` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `news_mention_cwid_status_show_on_profile_idx`(`cwid`, `status`, `show_on_profile`),
    UNIQUE INDEX `news_mention_cwid_url_key`(`cwid`, `url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `news_mention` ADD CONSTRAINT `news_mention_cwid_fkey` FOREIGN KEY (`cwid`) REFERENCES `scholar`(`cwid`) ON DELETE CASCADE ON UPDATE CASCADE;
