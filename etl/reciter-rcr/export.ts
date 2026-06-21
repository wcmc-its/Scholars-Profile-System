/**
 * RCR EXPORT (bridge half 1) — read NIH iCite bibliometrics from `reciterdb.analysis_nih`
 * (RCR / NIH percentile / iCite citation count, keyed by pmid), bounded to the WCM publication
 * corpus, and write them as NDJSON to S3 for the in-VPC importer (`import.ts`).
 *
 * Why this exists: `analysis_nih` is reachable from a reciterdb-reachable / TGW-attached client
 * but NOT from the in-VPC ETL task (#443); the Sps Aurora is reachable only in-VPC. See
 * `shared.ts`. Mirrors `etl/clinical-trials/export.ts`.
 *
 * Bound: only pmids in the WCM corpus (`reciterdb.analysis_summary_author`) are exported — the
 * same pmid universe the reciter ETL builds the publication table from — so the file stays small
 * and never carries the whole NIH iCite dataset.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   SCHOLARS_RECITERDB_*   (reciterdb connection; on a reciterdb-reachable host)
 *   RCR_BUCKET             (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   RCR_KEY                (the S3 key; or pass `--key <key>`; default citations/rcr-bridge.ndjson)
 *   AWS_DEFAULT_REGION     (default us-east-1)
 *
 * Usage (reciterdb-reachable client):
 *   npm run etl:reciter-rcr:export
 *   npm run etl:reciter-rcr:export -- --dry-run    # read + count, no upload
 */
import "dotenv/config";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";
import { chunks, RCR_BATCH, serializeRcrNdjson, type RcrRow } from "./shared";

const BUCKET = process.env.RCR_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
// Under the `citations/` prefix — already granted to the in-VPC ETL task role (no IAM change).
const DEFAULT_KEY = "citations/rcr-bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.RCR_KEY ?? DEFAULT_KEY;
}

type NihDbRow = {
  pmid: number;
  relative_citation_ratio: number | null;
  nih_percentile: number | null;
  citation_count: number | null;
};

/** Read the WCM pmid set then batch-fetch analysis_nih for it. */
async function readRcrRows(): Promise<RcrRow[]> {
  let pmids: number[] = [];
  await withReciterConnection(async (conn) => {
    const rows = (await conn.query(
      "SELECT DISTINCT pmid FROM analysis_summary_author WHERE pmid IS NOT NULL",
    )) as Array<{ pmid: number }>;
    pmids = rows.map((r) => Number(r.pmid)).filter((n) => Number.isFinite(n));
  });
  console.log(`WCM corpus: ${pmids.length} distinct pmids; fetching analysis_nih...`);

  const out: RcrRow[] = [];
  for (const batch of chunks(pmids, RCR_BATCH)) {
    await withReciterConnection(async (conn) => {
      const rows = (await conn.query(
        `SELECT pmid, relative_citation_ratio, nih_percentile, citation_count
         FROM analysis_nih WHERE pmid IN (?)`,
        [batch],
      )) as NihDbRow[];
      for (const r of rows) {
        out.push({
          pmid: String(r.pmid),
          rcr: r.relative_citation_ratio,
          percentile: r.nih_percentile,
          citedBy: r.citation_count,
        });
      }
    });
  }
  return out;
}

async function main() {
  const start = Date.now();
  try {
    const rows = await readRcrRows();
    console.log(`Fetched ${rows.length} analysis_nih rows for the WCM corpus.`);
    const ndjson = serializeRcrNdjson(rows);
    const key = resolveKey();
    if (dryRun) {
      console.log(`DRY-RUN: would upload ${rows.length} RCR rows to s3://${BUCKET}/${key} (not written).`);
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
      console.log(`Uploaded ${rows.length} RCR rows to s3://${BUCKET}/${key}.`);
    }
    if (rows.length === 0) {
      console.warn(
        "WARNING: 0 analysis_nih rows fetched — verify SCHOLARS_RECITERDB_* + reciterdb " +
          "reachability before trusting a clean run.",
      );
    }
  } finally {
    await closeReciterPool();
  }
  console.log(`${dryRun ? "DRY-RUN " : ""}Export complete in ${Math.round((Date.now() - start) / 1000)}s.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
