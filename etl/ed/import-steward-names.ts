/**
 * Steward-name IMPORT (bridge) — load `steward_directory` from a
 * `{ cwid, displayName }` NDJSON object on S3 instead of from WCM ED LDAP.
 *
 * Why this exists: a comms_steward's name lives only in the WCM directory, which
 * the in-VPC ETL cannot reach (#443). The companion export
 * (`export-steward-names.ts`) runs WCM-side, reads LDAP, and uploads the NDJSON;
 * this importer — run in-VPC as a normal `run-task` — reads it and upserts the
 * environment's Aurora. Idempotent / safe to re-run. The S3 read rides the
 * existing etl `ed/*` grant (cdk/lib/etl-stack.ts), so no IAM change is needed.
 *
 * Upsert (not updateMany like the email bridge): these CWIDs are external-affairs
 * staff with no `Scholar` row, so `steward_directory` is their own table and a
 * row is created if absent. A CWID dropped from the allowlist later leaves a
 * stale row — harmless (it's only read for stewards the app still recognises),
 * and a future run with the smaller export simply stops refreshing it.
 *
 * NDJSON contract: one object per line — `{ cwid, displayName }`. Blank /
 * unparseable / missing-field lines are skipped + counted (`parseStewardNameRows`).
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   STEWARD_NAMES_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   STEWARD_NAMES_KEY      (or `--key <key>`; default ed/steward-names/bridge.ndjson)
 *   AWS_DEFAULT_REGION     (default us-east-1)
 *
 * Usage (in-VPC run-task):
 *   npm run etl:ed:import-steward-names
 *   npm run etl:ed:import-steward-names -- --dry-run   # parse + count only, no DB
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { parseStewardNameRows } from "./steward-names";

const BUCKET =
  process.env.STEWARD_NAMES_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ed/steward-names/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.STEWARD_NAMES_KEY ?? DEFAULT_KEY;
}

async function main() {
  const start = Date.now();
  const key = resolveKey();

  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await resp.Body!.transformToString("utf-8");

  const { rows, skipped } = parseStewardNameRows(text);
  console.log(`Parsed ${rows.length} rows (${skipped} skipped).`);

  if (dryRun) {
    for (const r of rows) console.log(`  ${r.cwid} -> ${r.displayName}`);
    console.log("DRY-RUN: parsed only, no DB writes.");
    if (rows.length === 0) {
      console.warn("WARNING: 0 rows parsed — verify the NDJSON key before a real run.");
    }
    return;
  }

  const run = await db.write.etlRun.create({
    data: { source: "ED-StewardNames-Import", status: "running" },
  });
  try {
    let upserted = 0;
    for (const r of rows) {
      await db.write.stewardDirectory.upsert({
        where: { cwid: r.cwid },
        create: { cwid: r.cwid, displayName: r.displayName },
        update: { displayName: r.displayName },
      });
      upserted++;
    }
    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: upserted },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`Import complete in ${elapsed}s: ${upserted} steward name(s) upserted.`);
    if (upserted === 0) {
      console.warn("WARNING: 0 rows upserted — verify the NDJSON key before trusting a clean run.");
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
