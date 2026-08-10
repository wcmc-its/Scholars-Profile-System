/**
 * Data-sharing EXPORT (bridge half 1) — read `reciterdb.dataset_deposit` and
 * write its raw rows as NDJSON to S3, for the in-VPC importer (`import.ts`)
 * to load into the environment's Aurora.
 *
 * Why this exists: the source table lives in reciterdb, reachable from a
 * WCM-side / TGW-attached client but NOT from the in-VPC ETL task (SPS↔WCM
 * networking is not set up yet — #443; the in-VPC `etl:data-sharing` would
 * fail the same way `etl:clinical-trials` does against reciterdb).
 * Conversely the deployed environments' Aurora is reachable only in-VPC. So
 * neither side can do the read+write in one place. This pair closes the gap
 * exactly like etl/clinical-trials/{export,import}.ts: a reciterdb-reachable
 * client runs THIS export and uploads to S3; the importer — run in-VPC as a
 * normal `run-task` — reads it and writes Aurora.
 *
 * NDJSON contract: one JSON object per line —
 *   { cwid, repository, accessionOrDoi, resourceType, dataType, accessModel,
 *     depositYear, provenance, confidence, authorPosition, pmid }
 * Raw source rows — the importer applies the SAME build (etl/data-sharing/
 * shared.ts), so the bridge and direct paths can't drift.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   SCHOLARS_RECITERDB_*   (reciterdb connection; already in ~/.zshrc on a
 *                          reciterdb-reachable host)
 *   DATA_SHARING_BUCKET    (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   DATA_SHARING_KEY       (the S3 key; or pass `--key <key>`;
 *                          default data-sharing/bridge.ndjson)
 *   AWS_DEFAULT_REGION     (default us-east-1)
 *
 * Usage (reciterdb-reachable client):
 *   npm run etl:data-sharing:export
 *   npm run etl:data-sharing:export -- --key data-sharing/bridge.ndjson
 *   npm run etl:data-sharing:export -- --dry-run   # read + count, no upload
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { closeReciterPool } from "@/lib/sources/reciterdb";
import { readSourceRows } from "./shared";

const BUCKET =
  process.env.DATA_SHARING_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "data-sharing/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

/** Resolve the S3 key from `--key <key>` or DATA_SHARING_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.DATA_SHARING_KEY ?? DEFAULT_KEY;
}

async function main() {
  const start = Date.now();

  try {
    console.log("Loading dataset_deposit from reciterdb...");
    const rows = await readSourceRows();
    console.log(`Fetched ${rows.length} source rows.`);

    const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

    const key = resolveKey();
    if (dryRun) {
      console.log(`DRY-RUN: would upload ${rows.length} rows to s3://${BUCKET}/${key} (not written).`);
    } else {
      const s3 = new S3Client({ region: REGION });
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: ndjson,
          ContentType: "application/x-ndjson",
        }),
      );
      console.log(`Uploaded ${rows.length} rows to s3://${BUCKET}/${key}.`);
    }

    if (rows.length === 0) {
      console.warn(
        "WARNING: 0 rows fetched — verify the SCHOLARS_RECITERDB_* env and reciterdb " +
          "reachability before trusting a clean run (the importer refuses to load an empty " +
          "export over good data, but don't rely on that).",
      );
    }
  } finally {
    await closeReciterPool();
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`${dryRun ? "DRY-RUN " : ""}Export complete in ${elapsed}s.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
