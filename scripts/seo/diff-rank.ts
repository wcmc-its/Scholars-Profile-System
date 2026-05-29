/**
 * Diff two rank snapshots into a before/after report.
 *
 *   npm run seo:diff                                  # auto: two most recent snapshots
 *   npm run seo:diff -- --before <a.json> --after <b.json>
 *   npm run seo:diff -- --csv data/seo/rank-diff.csv  # also write the per-query CSV
 *
 * Prints a markdown summary (avg position before/after, movers) to stdout and
 * optionally writes the full per-(query,target) CSV. Positive delta = moved up.
 *
 * The honest workflow: snapshot the LEGACY VIVO domain before cutover, the NEW
 * Scholars domain ~30 and ~90 days after (rank dips during reindex, then
 * recovers), and diff. Lead with the topical query movement.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  diffSnapshots,
  toCsv,
  toMarkdownReport,
  type RankSnapshot,
} from "@/lib/seo/rank-basket";

const SNAPSHOT_DIR = path.resolve(process.cwd(), "data", "seo", "snapshots");

function getFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Find the two most recent snapshot files by filename (timestamps sort lexically). */
async function autoSnapshots(): Promise<{ before: string; after: string }> {
  let entries: string[] = [];
  try {
    entries = (await fs.readdir(SNAPSHOT_DIR))
      .filter((f) => f.startsWith("rank-") && f.endsWith(".json"))
      .sort();
  } catch {
    entries = [];
  }
  if (entries.length < 2) {
    throw new Error(
      `Need two snapshots in ${SNAPSHOT_DIR} for auto-diff (found ${entries.length}). ` +
        `Pass --before and --after explicitly.`,
    );
  }
  return {
    before: path.join(SNAPSHOT_DIR, entries[entries.length - 2]),
    after: path.join(SNAPSHOT_DIR, entries[entries.length - 1]),
  };
}

async function readSnapshot(p: string): Promise<RankSnapshot> {
  return JSON.parse(await fs.readFile(p, "utf8")) as RankSnapshot;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let beforePath = getFlag(argv, "--before");
  let afterPath = getFlag(argv, "--after");

  if (!beforePath || !afterPath) {
    const auto = await autoSnapshots();
    beforePath ??= auto.before;
    afterPath ??= auto.after;
    console.error(`[seo:diff] auto-selected:\n  before: ${beforePath}\n  after:  ${afterPath}\n`);
  }

  const [before, after] = await Promise.all([
    readSnapshot(beforePath),
    readSnapshot(afterPath),
  ]);

  const rows = diffSnapshots(before, after);
  const comparedIds = new Set(rows.map((r) => r.id));
  const onlyAfter = after.rows.filter((r) => !before.rows.some((b) => b.id === r.id)).length;
  if (onlyAfter > 0) {
    console.error(
      `[seo:diff] note: ${onlyAfter} queries in the after-snapshot were absent from the before-snapshot (basket changed) and are excluded from the diff. Compared ${comparedIds.size} queries.`,
    );
  }

  process.stdout.write(toMarkdownReport(before, after, rows));

  const csvPath = getFlag(argv, "--csv");
  if (csvPath) {
    await fs.mkdir(path.dirname(csvPath), { recursive: true });
    await fs.writeFile(csvPath, toCsv(rows), "utf8");
    console.error(`\n[seo:diff] wrote per-query CSV to ${csvPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
