/**
 * Regenerate etl/technologies/technologies.json from CTL's public portfolio.
 *
 *   npx tsx scripts/scrape-ctl-technologies.ts            # writes the seed
 *   npx tsx scripts/scrape-ctl-technologies.ts --stdout   # prints it
 *
 * The nightly ETL scrapes CTL directly (etl/technologies/index.ts), so this seed
 * is NOT the production source of truth. It exists so local dev and CI have an
 * offline fixture (`TECHNOLOGIES_SEED_PATH`), and so a human can eyeball the
 * diff when CTL's portfolio changes.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { scrapePortfolio } from "../etl/technologies/scrape";

const OUT = "etl/technologies/technologies.json";

async function main(): Promise<void> {
  const { rows, pages, fetchFailed, pagesWithoutCwidLink } = await scrapePortfolio();
  const json = JSON.stringify(rows, null, 1) + "\n";

  const toStdout = process.argv.includes("--stdout");
  if (toStdout) process.stdout.write(json);
  else writeFileSync(resolve(process.cwd(), OUT), json, "utf-8");

  console.error(
    JSON.stringify({
      pages,
      fetchFailed,
      pagesWithoutCwidLink,
      rows: rows.length,
      scholars: new Set(rows.map((r) => r.cwid)).size,
      out: toStdout ? "(stdout)" : OUT,
    }),
  );
}

main().catch((err) => {
  console.error(`[scrape-ctl-technologies] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
