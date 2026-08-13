/**
 * Data-sharing IMPORT (bridge half 2) — load `dataset_deposit` +
 * `person_dataset_deposit` from the NDJSON the export half wrote to S3,
 * instead of reading reciterdb directly.
 *
 * Why this exists: see export.ts. reciterdb is unreachable from the in-VPC
 * ETL task (#443); the Sps Aurora is reachable only in-VPC. The export runs
 * on a reciterdb-reachable client and uploads raw rows to S3; this importer —
 * run in-VPC as a normal `run-task` — reads them, applies the SAME build as
 * the direct ETL (etl/data-sharing/shared.ts), and full-replaces the two
 * tables. Idempotent / safe to re-run.
 *
 * SAFETY: this full-replaces (delete-all + insert-all). An empty or corrupt
 * export would otherwise wipe good data, so the importer REFUSES to proceed
 * when the NDJSON yields 0 rows — pass `--allow-empty` only to deliberately
 * clear the tables.
 *
 * NDJSON contract: see export.ts (one raw source-row object per line, including
 * sensitiveCats/sensitiveSubtypes). Blank and malformed lines are skipped + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   DATA_SHARING_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   DATA_SHARING_KEY      (the S3 key; or pass `--key <key>`;
 *                         default data-sharing/bridge.ndjson)
 *   AWS_DEFAULT_REGION    (default us-east-1)
 *
 * Usage (in-VPC run-task):
 *   npm run etl:data-sharing:import
 *   npm run etl:data-sharing:import -- --key data-sharing/bridge.ndjson
 *   npm run etl:data-sharing:import -- --dry-run      # parse + build + count, no DB writes
 *   npm run etl:data-sharing:import -- --allow-empty  # permit clearing the tables
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { buildDepositsAndLinks, loadScholars, replaceAll, type SourceRow } from "./shared";

const BUCKET =
  process.env.DATA_SHARING_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "data-sharing/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

/** Resolve the S3 key from `--key <key>` or DATA_SHARING_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.DATA_SHARING_KEY ?? DEFAULT_KEY;
}

/** Parse the NDJSON back into raw source rows. */
function parseNdjson(text: string): { rows: SourceRow[]; skipped: number } {
  const rows: SourceRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>;
      rows.push({
        cwid: (o.cwid as string) ?? null,
        repository: (o.repository as string) ?? null,
        accessionOrDoi: (o.accessionOrDoi as string) ?? null,
        resourceType: (o.resourceType as string) ?? null,
        dataType: (o.dataType as string) ?? null,
        sensitiveCats: (o.sensitiveCats as string) ?? null,
        sensitiveSubtypes: (o.sensitiveSubtypes as string) ?? null,
        accessModel: (o.accessModel as string) ?? null,
        depositYear: (o.depositYear as number | string) ?? null,
        provenance: (o.provenance as string) ?? null,
        confidence: (o.confidence as string) ?? null,
        authorPosition: (o.authorPosition as string) ?? null,
        pmid: (o.pmid as string) ?? null,
        title: (o.title as string) ?? null,
        description: (o.description as string) ?? null,
        creators: (o.creators as string) ?? null,
        publisher: (o.publisher as string) ?? null,
        trialPhase: (o.trialPhase as string) ?? null,
        trialStatus: (o.trialStatus as string) ?? null,
        trialConditions: (o.trialConditions as string) ?? null,
      });
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

async function main() {
  const start = Date.now();
  const now = new Date();
  const key = resolveKey();

  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await resp.Body!.transformToString("utf-8");

  const { rows, skipped } = parseNdjson(text);
  console.log(`Parsed ${rows.length} rows (${skipped} lines skipped).`);

  // SAFETY: refuse to full-replace from an empty/corrupt export — that would
  // delete-all and insert-nothing, wiping good data. --allow-empty overrides.
  if (rows.length === 0 && !allowEmpty) {
    throw new Error(
      "Refusing to import: 0 rows parsed (would wipe existing deposits). " +
        "Verify the S3 key/export, or pass --allow-empty to deliberately clear the tables.",
    );
  }

  const scholars = await loadScholars();
  const { deposits, links, stats } = buildDepositsAndLinks(rows, scholars, now);
  console.log(
    `Built ${stats.deposits} deposits and ${stats.links} person links. ` +
      `Skipped ${stats.skippedNoKey} rows w/o a repository/accession key, ` +
      `${stats.skippedUnknownCwid} w/ cwid not in this env's scholar set.`,
  );

  if (rows.length > 0 && deposits.length === 0 && !allowEmpty) {
    throw new Error(
      `Refusing to import: ${rows.length} source rows but 0 deposits built ` +
        "(join/scholar-set mismatch?). Pass --allow-empty to clear the tables anyway.",
    );
  }

  if (dryRun) {
    console.log("DRY-RUN: parsed + built only, no DB writes.");
    console.log(`DRY-RUN Import complete in ${Math.round((Date.now() - start) / 1000)}s.`);
    return;
  }

  const runRow = await db.write.etlRun.create({
    data: { source: "DataSharing-Import", status: "running" },
  });
  try {
    const r = await replaceAll(deposits, links);
    await db.write.etlRun.update({
      where: { id: runRow.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: r.insLinks },
    });
    console.log(
      `Import complete in ${Math.round((Date.now() - start) / 1000)}s: ` +
        `deleted ${r.delLinks} links / ${r.delDeposits} deposits, ` +
        `inserted ${r.insDeposits} deposits / ${r.insLinks} person links.`,
    );
  } catch (err) {
    await db.write.etlRun.update({
      where: { id: runRow.id },
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
