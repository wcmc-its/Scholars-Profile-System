/**
 * COI-statement IMPORT (bridge) — load `publication_conflict_statement` from an
 * NDJSON object on S3 instead of from ReciterDB (#594 follow-on).
 *
 * Why this exists: the normal ingester (`backfill-coi-statements.ts`) reads the
 * WCM ReciterDB, which is reachable from a WCM-side client but NOT from the
 * in-VPC ETL task (the SPS↔WCM networking is not set up yet). Conversely the
 * deployed environments' Aurora is reachable only in-VPC. So neither side can do
 * the read+write in one place. This job closes that gap: a WCM-side client runs
 * the backfill against its local DB, exports the table to NDJSON, and uploads it
 * to S3; this importer — run in-VPC as a normal `run-task` — reads that NDJSON
 * and upserts it into the environment's Aurora. Idempotent / safe to re-run.
 *
 * It writes the SAME rows, in the SAME shape, as the backfill: paper-level
 * verbatim text keyed by pmid. No per-author attribution is computed here (that
 * stays at request time in `lib/coi-gap`). Once the statements land, the normal
 * `etl:coi-gap` job (also in-VPC, not VPC-blocked) produces the candidates.
 *
 * NDJSON contract: one JSON object per line — `{ pmid, statementText, source? }`.
 * Blank lines are skipped; a line missing pmid/statementText is skipped + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   COI_STATEMENTS_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   COI_STATEMENTS_KEY      (the S3 key; or pass `--key <key>`)
 *   AWS_DEFAULT_REGION      (default us-east-1)
 *
 * Usage:
 *   npm run etl:reciter:import-coi-statements -- --key coi-statements/bridge.ndjson
 *   npm run etl:reciter:import-coi-statements -- --key <key> --dry-run   # parse only
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";

const BUCKET =
  process.env.COI_STATEMENTS_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const UPSERT_BATCH = 500;

const dryRun = process.argv.includes("--dry-run");

/** Resolve the S3 key from `--key <key>` or COI_STATEMENTS_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  const key = fromArgv ?? process.env.COI_STATEMENTS_KEY;
  if (!key) throw new Error("No S3 key — pass --key <key> or set COI_STATEMENTS_KEY");
  return key;
}

type Row = { pmid: string; statementText: string; source: string };

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
      const pmid = o.pmid != null ? String(o.pmid) : "";
      const statementText = typeof o.statementText === "string" ? o.statementText : "";
      if (!/^[0-9]+$/.test(pmid) || statementText.length === 0) {
        skipped++;
        continue;
      }
      rows.push({ pmid, statementText, source: typeof o.source === "string" ? o.source : "PubMed" });
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

async function main() {
  const start = Date.now();
  const key = resolveKey();
  const run = await db.write.etlRun.create({
    data: { source: "COI-Statements-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped } = parseNdjson(text);
    console.log(`Parsed ${rows.length} statements (${skipped} lines skipped).`);

    // Only statements whose pmid exists in the TARGET's `publication` table can be
    // stored — `publication_conflict_statement.pmid` is a FK to `publication.pmid`.
    // The env where the dump was generated can have a different pub set than the
    // target, so filter against the target here (this job runs in the target's VPC,
    // so it sees the target's pubs). Mirrors `backfill-coi-statements`, which only
    // pulls statements for pmids already in `publication`.
    const existingPmids = new Set(
      (await db.read.publication.findMany({ select: { pmid: true } })).map((p) => p.pmid),
    );
    const toWrite = rows.filter((r) => existingPmids.has(r.pmid));
    const noPub = rows.length - toWrite.length;
    console.log(
      `${toWrite.length} match an existing publication in this env (${noPub} have no matching pmid, skipped).`,
    );

    let written = 0;
    if (!dryRun) {
      for (const batch of chunks(toWrite, UPSERT_BATCH)) {
        await db.write.$transaction(
          batch.map((r) =>
            db.write.publicationConflictStatement.upsert({
              where: { pmid: r.pmid },
              create: { pmid: r.pmid, statementText: r.statementText, source: r.source },
              update: { statementText: r.statementText, source: r.source, lastRefreshedAt: new Date() },
            }),
          ),
        );
        written += batch.length;
        if (written % (UPSERT_BATCH * 10) === 0) console.log(`  ...${written}/${toWrite.length}`);
      }
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: written },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `${dryRun ? "DRY-RUN " : ""}Import complete in ${elapsed}s: ${written} upserted of ${toWrite.length} matched` +
        ` (${rows.length} parsed, ${skipped} skipped, ${noPub} no matching pmid).`,
    );
    if (!dryRun && toWrite.length === 0) {
      console.warn(
        "WARNING: 0 statements matched an existing publication — verify the NDJSON key and the env's publication set.",
      );
    }
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
