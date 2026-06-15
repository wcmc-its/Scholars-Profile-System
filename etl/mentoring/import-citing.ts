/**
 * Publication-citing IMPORT (bridge) — issue #928.
 *
 * Loads the `publication_citing` table from an NDJSON object on S3 (produced
 * WCM-side by `etl:mentoring:export-citing`) instead of from the live WCM
 * ReciterDB query the in-VPC app can't reach. Run in-VPC as a normal `run-task`.
 * Idempotent / safe to re-run. Full refresh via truncate-load (deleteMany +
 * chunked createMany): the table is fully replaced each run, so a pmid that
 * dropped to zero NIH cites simply doesn't reappear.
 *
 * Once the table is populated, the read layer uses it when
 * `PUBLICATION_CITING_BRIDGE=on` (import-then-flip — see
 * `lib/api/publication-detail.ts`). An empty table degrades honestly to the
 * "temporarily unavailable" modal state, so the flag is safe to flip only after
 * a successful import. No FK to Publication.
 *
 * NDJSON contract: one object per line —
 *   { pmid, total, citingPubs: [{ pmid, title, journal, year }] }
 * Blank lines are skipped; a line missing pmid/total is skipped + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET  (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   PUBLICATION_CITING_KEY   (default citations/citing.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *
 * Usage:
 *   npm run etl:mentoring:import-citing
 *   npm run etl:mentoring:import-citing -- --key citations/citing.ndjson
 *   npm run etl:mentoring:import-citing -- --dry-run      # parse only
 *   npm run etl:mentoring:import-citing -- --allow-empty  # permit a 0-row load
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { Prisma } from "@/lib/generated/prisma/client";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const INSERT_BATCH = 500;

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.PUBLICATION_CITING_KEY ?? "citations/citing.ndjson";
}

type CitingPubItem = { pmid: number; title: string; journal: string | null; year: number | null };
type Row = { pmid: number; total: number; citingPubs: CitingPubItem[] };

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Parse NDJSON → validated rows. Returns rows + a skipped-line count. */
function parseNdjson(text: string): { rows: Row[]; skipped: number } {
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Partial<Row>;
      const pmid = typeof o.pmid === "number" && Number.isInteger(o.pmid) ? o.pmid : NaN;
      const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : NaN;
      if (!Number.isInteger(pmid) || pmid <= 0 || !Number.isFinite(total) || total < 0) {
        skipped++;
        continue;
      }
      const citingPubs = Array.isArray(o.citingPubs) ? (o.citingPubs as CitingPubItem[]) : [];
      rows.push({ pmid, total, citingPubs });
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

async function main() {
  const start = Date.now();
  const importedAt = new Date();
  const key = resolveKey();
  const run = await db.write.etlRun.create({
    data: { source: "Publication-Citing-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped } = parseNdjson(text);
    console.log(`Parsed ${rows.length} cited-pmid rows (${skipped} lines skipped).`);

    // Empty-export guard: never wipe a populated table from a corrupt/empty S3
    // object. A genuine empty load (e.g. first run before ReciterDB has cites)
    // must pass --allow-empty.
    if (!dryRun && rows.length === 0 && !allowEmpty) {
      throw new Error(
        "Refusing to load 0 rows into publication_citing (would wipe the table). " +
          "Pass --allow-empty if this is intentional.",
      );
    }

    let written = 0;
    if (!dryRun) {
      // Full refresh via TRUNCATE-LOAD (the import-aoc pattern, chunked for
      // volume): one deleteMany, then chunked createMany. createMany issues ONE
      // multi-row INSERT per chunk, so ~170K rows load in ~chunkCount statements
      // instead of one-per-row upsert round-trips — the latter blow Prisma's 5 s
      // interactive-transaction timeout (P2028) on a table this size, since the
      // cost here is round-trip count, not row size (the citing list is small,
      // article-metadata-limited).
      //
      // NON-transactional by design: a single interactive $transaction over ~170K
      // rows would blow the P2028 timeout, so the delete + chunked reload run
      // outside a transaction. On the FIRST import (flag off) the empty window is
      // never observed. On a STEADY-STATE re-import (PUBLICATION_CITING_BRIDGE
      // already on), once the first chunk commits the existence probe sees rows,
      // so a cited pmid not-yet-reinserted briefly renders "cited by 0" rather
      // than "temporarily unavailable" (#991) — it self-heals within the seconds
      // the reload takes. To avoid the window entirely, flip the bridge flag OFF
      // before a steady-state re-import and back on when it completes. The
      // empty-export guard above protects the table from a corrupt/empty object.
      await db.write.publicationCiting.deleteMany({});
      for (const batch of chunks(rows, INSERT_BATCH)) {
        await db.write.publicationCiting.createMany({
          data: batch.map((r) => ({
            pmid: r.pmid,
            total: r.total,
            citingPubs: r.citingPubs as unknown as Prisma.InputJsonValue,
            refreshedAt: importedAt,
          })),
          skipDuplicates: true,
        });
        written += batch.length;
        if (written % (INSERT_BATCH * 20) === 0) console.log(`  ...${written}/${rows.length}`);
      }
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: written },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `${dryRun ? "DRY-RUN " : ""}Import complete in ${elapsed}s: ${written} upserted ` +
        `(${rows.length} parsed, ${skipped} skipped).`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
