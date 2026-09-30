-- Media Highlights: press outlet for a "WCM in the News" clip row (etl/news/clips.ts).
ALTER TABLE `news_mention` ADD COLUMN `outlet` VARCHAR(255) NULL;
