/**
 * RCR IMPORT (bridge half 2) — load NIH iCite bibliometrics from the NDJSON the export half
 * wrote to S3 and UPDATE the matching `publication` rows. Runs in-VPC (the Sps Aurora is
 * reachable only there). See `shared.ts` / `export.ts`.
 *
 * NON-DESTRUCTIVE: only UPDATEs `relative_citation_ratio` / `nih_percentile` / `cited_by_count`
 * on EXISTING publications (pmid match, pre-filtered against the publication table). It never
 * deletes or inserts, so a partial/empty export can only under-enrich, never wipe data — there is
 * no "refuse on empty" guard to need. Idempotent / safe to re-run.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   RCR_BUCKET             (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   RCR_KEY                (the S3 key; or pass `--key <key>`; default citations/rcr-bridge.ndjson)
 *   AWS_DEFAULT_REGION     (default us-east-1)
 *
 * Usage (in-VPC run-task):
 *   npm run etl:reciter-rcr:import
 *   npm run etl:reciter-rcr:import -- --dry-run    # parse + intersect + count, no DB writes
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { chunks, parseRcrNdjson, type RcrRow } from "./shared";

/** Concurrent per-pmid updates per batch — modest so the connection pool isn't swamped. */
const UPDATE_CONCURRENCY = 100;

const BUCKET = process.env.RCR_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "citations/rcr-bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.RCR_KEY ?? DEFAULT_KEY;
}

/** Update one pmid's three bibliometric columns; returns 1 if a row matched, else 0. */
async function updateOne(r: RcrRow): Promise<number> {
  const res = await db.write.publication.updateMany({
    where: { pmid: r.pmid },
    data: {
      relativeCitationRatio: r.rcr,
      nihPercentile: r.percentile,
      citedByCount: r.citedBy,
    },
  });
  return res.count;
}

async function main() {
  const start = Date.now();
  const key = resolveKey();

  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await resp.Body!.transformToString("utf-8");

  const { rows, skipped } = parseRcrNdjson(text);
  console.log(`Parsed ${rows.length} RCR rows (${skipped} lines skipped).`);

  // Only touch pmids that (a) exist in publication and (b) carry at least one metric — pre-load
  // the publication pmid set so we never issue a no-op update for a pmid we don't have.
  const existing = new Set<string>();
  {
    const pubs = await db.read.publication.findMany({ select: { pmid: true } });
    for (const p of pubs) existing.add(p.pmid);
  }
  const toUpdate = rows.filter(
    (r) => existing.has(r.pmid) && (r.rcr != null || r.percentile != null || r.citedBy != null),
  );
  console.log(
    `${existing.size} publications in this env; ${toUpdate.length} have a matching RCR row to apply.`,
  );

  if (dryRun) {
    console.log(`DRY-RUN: would update ${toUpdate.length} publications, no DB writes.`);
    console.log(`DRY-RUN Import complete in ${Math.round((Date.now() - start) / 1000)}s.`);
    return;
  }

  const runRow = await db.write.etlRun.create({
    data: { source: "RCR-Import", status: "running" },
  });
  try {
    let updated = 0;
    // Bounded concurrency: Promise.all within a batch, batches sequential — mirrors the reciter
    // upsert loop and keeps the connection pool from being swamped.
    for (const batch of chunks(toUpdate, UPDATE_CONCURRENCY)) {
      const counts = await Promise.all(batch.map(updateOne));
      updated += counts.reduce((a, b) => a + b, 0);
    }
    await db.write.etlRun.update({
      where: { id: runRow.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: updated },
    });
    console.log(
      `Import complete in ${Math.round((Date.now() - start) / 1000)}s: updated ${updated} publications.`,
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
