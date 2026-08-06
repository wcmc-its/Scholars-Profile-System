/**
 * Strip VIVO truncation-sentinel tails from stored overviews (#2207, one-shot per DB).
 *
 * 59 of the 552 active scholars with an overview (10.7%; 42 full-time faculty,
 * 15 affiliated, 2 non-faculty academic — prod, 2026-08-05) carry a body ending
 * in the exact sequence
 *
 *     <p></p> <p>[...]</p>
 *
 * which paints as a blank paragraph followed by a visible, literal `[...]`. All
 * 59 have no `overview_provenance` row, so the bodies arrived on the one-time
 * VIVO-era corpus load, not through the /edit generator: the `[...]` is the
 * upstream exporter's truncation marker and was never stripped on ingest.
 *
 * WHY BOTH A SANITIZER AND A BACKFILL. `sanitizeOverviewHtml`
 * (`lib/edit/validators.ts`) now applies `stripOverviewTailArtifacts`, and the
 * read-merge re-sanitizes on every read, so the public profile and /edit are
 * already clean without this script — and a re-import of the legacy corpus
 * cannot reintroduce the marker on those surfaces. But the read-merge is not the
 * only consumer of the raw column: the OpenSearch people document
 * (`lib/search-index-docs.ts`) and the overview generator's "existing bio" fact
 * (`lib/edit/overview-facts.ts`) both read `scholar.overview` directly, so
 * without this pass `[...]` stays in the search index and in an LLM prompt.
 *
 * TIMESTAMPS ARE DELIBERATELY NOT TOUCHED (#2212). `scholar.overview_updated_at`
 * already holds the corpus-load date for every seeded row and must not be made
 * to look like a content edit; `field_override.updated_at` is a real
 * scholar-edit timestamp, so the override rows are written with a raw UPDATE
 * (Prisma's `@updatedAt` is client-side and the column has no
 * ON UPDATE CURRENT_TIMESTAMP, so `updated_at` stays put). `scholar.updated_at`
 * does move — the row genuinely changed, and the ED ETL bumps it nightly anyway.
 *
 * Idempotent: rows are selected by "the strip changes the value", so a second
 * run finds nothing. Safe to repeat.
 *
 *   --dry-run   report the rows it WOULD rewrite; write nothing.
 *   --limit=N   cap the rows rewritten per table (sample against staging first).
 *
 * Run (operator-driven, per scripts/backfills/README.md) — dry-run first:
 *   npx tsx scripts/backfills/2026-08-05-strip-overview-tail-artifacts.ts --dry-run
 *   npx tsx scripts/backfills/2026-08-05-strip-overview-tail-artifacts.ts
 *
 * A repaired DB is not a repaired index: rerun `npm run search:index:people`
 * afterwards and verify by reading `_source` back, not by re-scanning Aurora.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { db } from "../../lib/db";
import {
  hasOverviewTailArtifact,
  stripOverviewTailArtifacts,
} from "../../lib/text/overview-artifacts";

const log = (msg: string) => console.log(msg);

/** Show the tail that is being removed, without printing the scholar's prose. */
function tail(value: string, keep = 60): string {
  const from = Math.max(0, value.length - keep);
  return (from > 0 ? "…" : "") + JSON.stringify(value.slice(from));
}

type Options = { dryRun: boolean; limit: number | null };

function parseArgs(argv: readonly string[]): Options {
  const dryRun = argv.includes("--dry-run");
  const raw = argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
  const parsed = raw === undefined ? null : Number.parseInt(raw, 10);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
    throw new Error(`--limit must be a positive integer (got ${raw})`);
  }
  return { dryRun, limit: parsed };
}

/** The ETL-seeded column — the 59 rows #2207 measured. */
async function fixScholarOverviews(opts: Options): Promise<number> {
  // No SQL prefilter: `[...]` is not indexable and the whole corpus is ~550
  // non-null overviews, so pulling them and testing in code is both cheaper to
  // read and guaranteed to agree with what the sanitizer does.
  const rows = await db.write.scholar.findMany({
    where: { overview: { not: null } },
    select: { cwid: true, overview: true },
    orderBy: { cwid: "asc" },
  });
  const dirty = rows.filter((r) => r.overview !== null && hasOverviewTailArtifact(r.overview));
  log(`scholar.overview: ${rows.length} non-null, ${dirty.length} with a tail artifact`);

  const targets = opts.limit === null ? dirty : dirty.slice(0, opts.limit);
  let written = 0;
  for (const row of targets) {
    const before = row.overview as string;
    const after = stripOverviewTailArtifacts(before);
    log(`  ${row.cwid}: ${tail(before)}  ->  ${tail(after)}`);
    if (opts.dryRun) continue;
    // `overviewUpdatedAt` is intentionally absent from `data` — see the header.
    await db.write.scholar.update({ where: { cwid: row.cwid }, data: { overview: after } });
    written += 1;
  }
  return opts.dryRun ? targets.length : written;
}

/**
 * The manual-layer override rows. #2207 measured only the ETL column, but an
 * override created by pasting a VIVO bio carries the same tail, and the people
 * index read-merges the override raw (`loadOverviewOverrides`, #2113).
 */
async function fixOverviewOverrides(opts: Options): Promise<number> {
  const rows = await db.write.fieldOverride.findMany({
    where: { entityType: "scholar", fieldName: "overview" },
    select: { id: true, entityId: true, value: true },
    orderBy: { entityId: "asc" },
  });
  const dirty = rows.filter((r) => hasOverviewTailArtifact(r.value));
  log(
    `field_override(scholar, overview): ${rows.length} rows, ` +
      `${dirty.length} with a tail artifact`,
  );

  const targets = opts.limit === null ? dirty : dirty.slice(0, opts.limit);
  let written = 0;
  for (const row of targets) {
    const after = stripOverviewTailArtifacts(row.value);
    log(`  ${row.entityId}: ${tail(row.value)}  ->  ${tail(after)}`);
    if (opts.dryRun) continue;
    // Raw UPDATE of `value` only, so `updated_at` — a genuine scholar-edit
    // timestamp — is not bumped by this mechanical rewrite (#2212).
    await db.write.$executeRaw`UPDATE field_override SET value = ${after} WHERE id = ${row.id}`;
    written += 1;
  }
  return opts.dryRun ? targets.length : written;
}

async function run(opts: Options): Promise<void> {
  log(
    `#2207 overview tail-artifact strip${opts.dryRun ? " [DRY RUN — no writes]" : ""}` +
      `${opts.limit === null ? "" : ` [limit=${opts.limit}]`}`,
  );
  const scholars = await fixScholarOverviews(opts);
  const overrides = await fixOverviewOverrides(opts);
  log(
    `\nDone${opts.dryRun ? " (dry run — nothing written)" : ""}: ` +
      `${scholars} scholar.overview + ${overrides} field_override row(s).`,
  );
  if (!opts.dryRun && scholars + overrides > 0) {
    log("NOTE: rerun `npm run search:index:people`, then verify by reading _source back.");
  }
}

const main = async () => {
  await run(parseArgs(process.argv.slice(2)));
  await db.write.$disconnect();
};

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
