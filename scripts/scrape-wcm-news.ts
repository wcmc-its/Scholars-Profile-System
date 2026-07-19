/**
 * Regenerate the checked-in offline fixture `etl/news/news.json` from the live
 * WCM news feed. NOT the production source — the ETL scrapes live; this only
 * refreshes the fixture used by CI / local dev (`NEWS_SEED_PATH`) and the tests.
 *
 *   npx tsx scripts/scrape-wcm-news.ts [maxPages=1]
 *
 * Defaults to one listing page (~5 newest articles) — enough for a smoke run and
 * small enough to review in a diff. Pass a larger page count for a fuller sample.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scrapeNews } from "../etl/news/scrape";

const maxPages = Number(process.argv[2]) || 1;
const out = resolve(process.cwd(), "etl/news/news.json");

async function main(): Promise<void> {
  const { articles, stubs, fetchFailed } = await scrapeNews(new Set(), { maxPages });
  if (articles.length === 0) {
    throw new Error(`[News] scrape yielded 0 articles (stubs=${stubs}) — markup changed?`);
  }
  writeFileSync(out, `${JSON.stringify(articles, null, 2)}\n`);
  console.log(
    `[News] wrote ${articles.length} articles (stubs=${stubs}, fetchFailed=${fetchFailed}) to ${out}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
