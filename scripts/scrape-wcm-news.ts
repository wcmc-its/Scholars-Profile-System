/**
 * Regenerate the checked-in offline fixture `etl/news/news.json` from the live
 * WCM Newsroom feed. NOT the production source — the ETL reads the feed live;
 * this only refreshes the fixture used by CI / local dev (`NEWS_SEED_PATH`).
 *
 *   npx tsx scripts/scrape-wcm-news.ts [limit=5]
 *
 * One feed page is 100 stories, so this takes the newest `limit` of them —
 * enough for a smoke run and small enough to review in a diff.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrapeNews } from "../etl/news/scrape";

const limit = Number(process.argv[2]) || 5;
const out = resolve(process.cwd(), "etl/news/news.json");

async function main(): Promise<void> {
  const articles = await scrapeNews(new Set(), { maxPages: 1 });
  if (articles.length === 0) {
    throw new Error("[News] feed yielded 0 articles — upstream shape changed?");
  }
  const sample = articles.slice(0, limit);
  writeFileSync(out, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`[News] wrote ${sample.length} of ${articles.length} articles to ${out}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
