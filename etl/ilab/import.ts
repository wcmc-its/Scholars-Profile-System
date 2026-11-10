/**
 * iLab core charges IMPORT: load `core_charge` from an iLab charges export
 * (xlsx) for the MCC shared-resource usage report.
 *
 * Each quarter the export is dropped at the S3 key and this runs as a normal
 * in-VPC `run-task`. A scheduled RAC extract can later write the same key with
 * no code change. For a manual run, `--file <path>` reads a local xlsx instead.
 *
 * Replace semantics: in ONE transaction, delete every `core_charge` row whose
 * ERP date falls in the file's [min, max] ERP-date range (plus any row whose
 * charge id the file carries), then insert the file's rows. Re-running the same
 * file is a no-op; a later file that overlaps the previous one supersedes it on
 * the overlap. Rows outside the range are untouched.
 *
 * SAFETY: refuses a file that yields 0 charges (wrong key, wrong sheet, or a
 * broken export); there is no range to replace and nothing to load.
 *
 * Env (AWS default credential chain; never hardcode keys):
 *   ILAB_BUCKET          (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   ILAB_KEY             (the S3 key; or pass `--key <key>`; default ilab/charges.xlsx)
 *   AWS_DEFAULT_REGION   (default us-east-1)
 *
 * Usage:
 *   npm run etl:ilab:import
 *   npm run etl:ilab:import -- --key ilab/charges.xlsx
 *   npm run etl:ilab:import -- --file ./charges.xlsx --dry-run
 */
import { readFile } from "node:fs/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { erpRange, readChargesWorkbook } from "./parse";

const BUCKET = process.env.ILAB_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ilab/charges.xlsx";
const INSERT_BATCH = 1000;

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
  const { charges, skipped } = await readChargesWorkbook(await loadBytes());
  const range = erpRange(charges);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  console.log(
    `Parsed ${charges.length} charges` +
      (range ? ` with ERP dates ${iso(range.from)}..${iso(range.to)}` : "") +
      `; skipped ${JSON.stringify(skipped)}.`,
  );

  if (!range) {
    throw new Error(
      "Refusing to import: 0 charges parsed. Verify the S3 key / file is an iLab charges export.",
    );
  }

  if (dryRun) {
    console.log("DRY-RUN: parsed only, no DB writes.");
    return;
  }

  const runRow = await db.write.etlRun.create({
    data: { source: "iLab-Import", status: "running" },
  });
  try {
    let deleted = 0;
    await db.write.$transaction(
      async (tx) => {
        deleted += (
          await tx.coreCharge.deleteMany({ where: { erpDate: { gte: range.from, lte: range.to } } })
        ).count;
        for (const batch of chunks(charges, INSERT_BATCH)) {
          deleted += (
            await tx.coreCharge.deleteMany({ where: { chargeId: { in: batch.map((c) => c.chargeId) } } })
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
