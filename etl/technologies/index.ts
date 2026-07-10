/**
 * CTL available-technologies ETL.
 *
 * Run via `npm run etl:technologies`; wired into the nightly chain in
 * etl/orchestrate.ts. One run does:
 *
 *   1. Scrape CTL's public portfolio (or read TECHNOLOGIES_SEED_PATH when set —
 *      the offline path for local dev and CI).
 *   2. Validate every row (origin-pinned url, well-formed cwid).
 *   3. Drop rows whose cwid has no `scholar` row (departed faculty, or a CWID
 *      the portfolio carries that Scholars does not). The count is logged —
 *      never silently truncated.
 *   4. VOLUME GUARD: abort without writing if the row count collapses versus
 *      what's already in the table. A CTL markup change must not blank the
 *      section on every profile.
 *   5. NO-OP SHORT-CIRCUIT: if the scraped rows are identical to the table's
 *      current contents, skip the write entirely. CTL's portfolio changes a few
 *      times a year, so almost every nightly run lands here — no truncate/insert
 *      churn, no `refreshed_at` bump, no CDN invalidation.
 *   6. Otherwise truncate + insert inside one $transaction, so an insert failure
 *      rolls back the truncate.
 *   7. Record the run in `etl_run` under source="Technology".
 *
 * The no-op check compares against the table rather than a stored content hash:
 * there is no hash to drift out of sync with the rows it describes.
 *
 * ponytail: unknown cwids are dropped, not resolved through `cwid_alias`. That
 * costs 9 of 129 CWIDs, none of whom have a `scholar` row under any name. If a
 * run logs a large `droppedUnknownCwid`, add an alias lookup before the filter.
 *
 * Env:
 *   TECHNOLOGIES_SEED_PATH   read this JSON instead of scraping (offline path)
 *   TECHNOLOGIES_MIN_RETAIN  volume-guard floor as a fraction of the existing
 *                            row count (default 0.8)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@/lib/db";
import { scrapePortfolio } from "./scrape";
import { parseSeed, validateRows, type TechnologyRow } from "./seed";

const SEED_PATH = process.env.TECHNOLOGIES_SEED_PATH;

/** Abort rather than shrink the table below this fraction of its current size. */
function minRetainFraction(): number {
  const n = Number(process.env.TECHNOLOGIES_MIN_RETAIN);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.8;
}

async function recordRun(args: {
  status: "success" | "failed";
  rowsProcessed: number;
  errorMessage?: string;
}): Promise<void> {
  await db.write.etlRun.create({
    data: {
      source: "Technology",
      status: args.status,
      completedAt: new Date(),
      rowsProcessed: args.rowsProcessed,
      errorMessage: args.errorMessage ?? null,
    },
  });
}

function readSeedFile(path: string): TechnologyRow[] {
  const abs = resolve(process.cwd(), path);
  try {
    return parseSeed(readFileSync(abs, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Returning [] here would wipe scholar_technology under a SUCCESS run.
      throw new Error(`[Technology] seed missing at ${abs} — refusing to treat as empty`);
    }
    throw err;
  }
}

/**
 * Stable identity of a row set, order-independent, for the no-op comparison.
 *
 * EVERY persisted field must appear here. A field omitted becomes invisible to
 * the change check, and the importer would skip its write forever.
 *
 * JSON-encodes each row rather than joining on a separator: a title or patent
 * status can contain any printable character, so no delimiter is safe, and an
 * unprintable one (NUL) makes git treat this source file as binary.
 */
export function fingerprint(rows: TechnologyRow[]): string {
  return rows
    .map((r) =>
      JSON.stringify([
        r.cwid,
        r.url,
        r.reference,
        r.title,
        r.patentStatus,
        [...r.pmids].sort(),
        r.overview,
        r.hasPocData,
      ]),
    )
    .sort()
    .join("\n");
}

async function replaceTechnologies(rows: TechnologyRow[]): Promise<void> {
  const CHUNK = 500;
  await db.write.$transaction(
    async (tx) => {
      await tx.scholarTechnology.deleteMany({});
      for (let i = 0; i < rows.length; i += CHUNK) {
        await tx.scholarTechnology.createMany({
          data: rows.slice(i, i + CHUNK).map((t) => ({
            cwid: t.cwid,
            reference: t.reference,
            title: t.title,
            url: t.url,
            patentStatus: t.patentStatus,
            pmids: t.pmids,
            overview: t.overview,
            hasPocData: t.hasPocData,
            refreshedAt: new Date(),
          })),
        });
      }
    },
    { timeout: 5 * 60 * 1000, maxWait: 30 * 1000 },
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const source = SEED_PATH ? "seed" : "scrape";
  const scraped = SEED_PATH ? readSeedFile(SEED_PATH) : (await scrapePortfolio()).rows;
  // The seed path is validated by parseSeed; validate the scrape on the same terms.
  const incoming = SEED_PATH ? scraped : validateRows(scraped);

  const known = new Set(
    (await db.write.scholar.findMany({ select: { cwid: true } })).map((s) => s.cwid),
  );
  const rows = incoming.filter((t) => known.has(t.cwid));
  const dropped = incoming.length - rows.length;

  if (rows.length === 0) {
    throw new Error(
      `[Technology] source produced ${incoming.length} rows but none match a scholar — aborting`,
    );
  }

  // Selects every persisted field, because `fingerprint` hashes every one of
  // them. `pmids` is a Json column, so narrow it back to string[] here.
  const current: TechnologyRow[] = (
    await db.write.scholarTechnology.findMany({
      select: {
        cwid: true,
        reference: true,
        title: true,
        url: true,
        patentStatus: true,
        pmids: true,
        overview: true,
        hasPocData: true,
      },
    })
  ).map((t) => ({
    ...t,
    pmids: Array.isArray(t.pmids) ? t.pmids.filter((p): p is string => typeof p === "string") : [],
  }));

  // Volume guard. Only meaningful once the table is populated; the first run
  // legitimately grows from zero. A partial CTL outage (some detail pages 5xx)
  // shrinks the scrape without throwing, and this is what catches it.
  const floor = Math.floor(current.length * minRetainFraction());
  if (current.length > 0 && rows.length < floor) {
    throw new Error(
      `[Technology] refusing to shrink scholar_technology ${current.length} → ${rows.length} ` +
        `(floor ${floor}, TECHNOLOGIES_MIN_RETAIN=${minRetainFraction()}) — CTL markup or outage?`,
    );
  }

  const unchanged = fingerprint(current) === fingerprint(rows);
  if (!unchanged) await replaceTechnologies(rows);
  await recordRun({ status: "success", rowsProcessed: rows.length });

  console.log(
    `[Technology] ${JSON.stringify({
      event: unchanged ? "technology_etl_noop" : "technology_etl_complete",
      source,
      sourceRows: incoming.length,
      rows: rows.length,
      droppedUnknownCwid: dropped,
      scholars: new Set(rows.map((r) => r.cwid)).size,
      changed: !unchanged,
      durationMs: Date.now() - startedAt,
    })}`,
  );
}

main()
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Technology] ${JSON.stringify({ event: "fatal", error: message })}`);
    await recordRun({ status: "failed", rowsProcessed: 0, errorMessage: message }).catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
