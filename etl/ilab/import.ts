/**
 * iLab core charges IMPORT: load `core_charge` from an iLab charges export
 * (xlsx) for the MCC shared-resource usage report.
 *
 * Each quarter the export is dropped at the S3 key and this runs as a normal
 * in-VPC `run-task`. A scheduled RAC extract can later write the same key with
 * no code change. For a manual run, `--file <path>` reads a local xlsx instead.
 *
 * Replace semantics: the operator names the quarter with `--from` / `--to`
 * (inclusive ERP dates, at most one quarter). In ONE transaction, delete every
 * `core_charge` row whose ERP date falls in that window (plus any row whose
 * charge id the loaded rows carry), then insert the file's rows in the window.
 * File rows outside the window are skipped and counted, never loaded, so a
 * stray old ERP date cannot widen the delete. Re-running the same file is a
 * no-op. Rows outside the window are untouched.
 *
 * SAFETY: refuses a window with 0 charges in the file (wrong key, wrong sheet,
 * wrong quarter, or a broken export), and refuses (guard `ilab:core-charge`)
 * when the window already holds far more rows than the file brings, e.g. an
 * export filtered to a subset of cores. Bypass a deliberate shrink with
 * ETL_GUARD_BYPASS="ilab:core-charge".
 *
 * Env (AWS default credential chain; never hardcode keys):
 *   ILAB_BUCKET          (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   ILAB_KEY             (the S3 key; or pass `--key <key>`; default ilab/charges.xlsx)
 *   AWS_DEFAULT_REGION   (default us-east-1)
 *
 * Usage:
 *   npm run etl:ilab:import -- --from 2026-07-01 --to 2026-09-30
 *   npm run etl:ilab:import -- --from 2026-07-01 --to 2026-09-30 --key ilab/charges.xlsx
 *   npm run etl:ilab:import -- --from 2026-07-01 --to 2026-09-30 --file ./charges.xlsx --dry-run
 */
import { readFile } from "node:fs/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { assertSourceVolume } from "../../lib/etl-guard";
import { chargesInWindow, erpRange, parseErpWindow, readChargesWorkbook } from "./parse";

const BUCKET =
  process.env.ILAB_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ilab/charges.xlsx";
const INSERT_BATCH = 1000;
/// Max tolerated shrink of the window's row count vs what is already loaded.
const MAX_DROP_PCT = 25;

const dryRun = process.argv.includes("--dry-run");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadBytes(): Promise<Uint8Array> {
  const file = arg("--file");
  if (file) {
    console.log(`Reading ${file} ...`);
    return readFile(file);
  }
  const key = arg("--key") ?? process.env.ILAB_KEY ?? DEFAULT_KEY;
  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return resp.Body!.transformToByteArray();
}

async function main() {
  const start = Date.now();
  const erpWindow = parseErpWindow(arg("--from"), arg("--to"));
  const { charges: parsed, skipped } = await readChargesWorkbook(await loadBytes());
  const range = erpRange(parsed);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const { inside: charges, outside } = chargesInWindow(parsed, erpWindow);
  console.log(
    `Parsed ${parsed.length} charges` +
      (range ? ` with ERP dates ${iso(range.from)}..${iso(range.to)}` : "") +
      `; ${charges.length} in window ${iso(erpWindow.from)}..${iso(erpWindow.to)}, ${outside} outside it (not loaded)` +
      `; skipped ${JSON.stringify(skipped)}.`,
  );
  if (skipped.badPrice + skipped.duplicateMismatch + skipped.longChargeId > 0) {
    console.warn(
      `WARNING: ${skipped.badPrice} unparseable prices, ${skipped.duplicateMismatch} repeated charge ids ` +
        `with a different price or payment, ${skipped.longChargeId} overlong charge ids were dropped; ` +
        "their dollars are missing from the report. Check the export.",
    );
  }

  if (charges.length === 0) {
    throw new Error(
      "Refusing to import: 0 charges in the window. Verify --from/--to and that the S3 key / file is an iLab charges export.",
    );
  }

  if (dryRun) {
    console.log("DRY-RUN: parsed only, no DB writes.");
    return;
  }

  assertSourceVolume("ilab:core-charge", {
    incoming: charges.length,
    existing: await db.write.coreCharge.count({
      where: { erpDate: { gte: erpWindow.from, lte: erpWindow.to } },
    }),
    maxDropPct: MAX_DROP_PCT,
  });

  const runRow = await db.write.etlRun.create({
    data: { source: "iLab-Import", status: "running" },
  });
  try {
    let deleted = 0;
    await db.write.$transaction(
      async (tx) => {
        deleted += (
          await tx.coreCharge.deleteMany({
            where: { erpDate: { gte: erpWindow.from, lte: erpWindow.to } },
          })
        ).count;
        for (const batch of chunks(charges, INSERT_BATCH)) {
          deleted += (
            await tx.coreCharge.deleteMany({
              where: { chargeId: { in: batch.map((c) => c.chargeId) } },
            })
          ).count;
          await tx.coreCharge.createMany({ data: batch });
        }
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await db.write.etlRun.update({
      where: { id: runRow.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: charges.length },
    });
    console.log(
      `Import complete in ${Math.round((Date.now() - start) / 1000)}s: ` +
        `deleted ${deleted}, inserted ${charges.length}.`,
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
