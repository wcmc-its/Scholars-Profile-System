-- Headshot presence, backfilled weekly by etl/headshot.
--
-- The app never reads the dormant `headshot_url` column at render time — it derives
-- the WCM directory URL from the cwid (`lib/headshot.ts`, `identityImageEndpoint`),
-- which 404s when no photo exists. So headshot presence is not otherwise knowable
-- server-side. etl/headshot probes that endpoint per active scholar and persists the
-- verdict here, giving the Data Quality dashboard an exact, sortable/filterable
-- signal. Both nullable so the additive migration applies cleanly; NULL = never
-- probed (the dashboard renders "— (not checked)" until the first run lands).
ALTER TABLE `scholar` ADD COLUMN `has_headshot` BOOLEAN NULL;
ALTER TABLE `scholar` ADD COLUMN `headshot_checked_at` DATETIME(3) NULL;
