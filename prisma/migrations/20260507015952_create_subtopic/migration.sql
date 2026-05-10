-- Backfill the missing CREATE TABLE for `subtopic`.
--
-- The Subtopic model in schema.prisma was promoted to a first-class entity
-- after the original phase2_topics migration (which only embeds subtopic IDs
-- as JSON columns on publication_topic). The d19 ALTER migration that follows
-- this one (20260507015953_add_d19_subtopic_fields) adds nullable display /
-- scoring fields to the table, but no migration ever created it. Existing
-- dev databases have the table from a prior `prisma db push` outside of
-- migration history; CI on a fresh DB had no such side door and failed.
--
-- IF NOT EXISTS makes this idempotent on existing dev DBs. The foreign key
-- to `topic(id)` is intentionally deferred — adding it idempotently against
-- DBs where it already exists requires conditional DDL that's awkward in a
-- single migration file. A follow-up migration will add the FK once dev DBs
-- have been reconciled or the codebase is squashed to a fresh baseline.

-- CreateTable
CREATE TABLE IF NOT EXISTS `subtopic` (
    `id` VARCHAR(128) NOT NULL,
    `parent_topic_id` VARCHAR(128) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `source` VARCHAR(64) NOT NULL,
    `refreshed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `subtopic_parent_topic_id_idx` (`parent_topic_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
