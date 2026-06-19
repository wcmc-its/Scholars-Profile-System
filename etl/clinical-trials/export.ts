/**
 * Clinical-trials EXPORT (bridge half 1) — read `reciterdb.clinical_trials` and
 * `clinical_trials_enriched` and write their raw rows as NDJSON to S3, for the
 * in-VPC importer (`import.ts`) to load into the environment's Aurora.
 *
 * Why this exists: the trial source tables live in reciterdb, reachable from a
 * WCM-side / TGW-attached client but NOT from the in-VPC ETL task (SPS↔WCM
 * networking is not set up yet — #443; the in-VPC `etl:clinical-trials` fails at
 * "failed to create socket after 2000ms" against reciterdb). Conversely the
 * deployed environments' Aurora is reachable only in-VPC. So neither side can do
 * the read+write in one place. This pair closes the gap exactly like the ED
 * email-visibility bridge (export-email-visibility.ts + import-email-visibility.ts):
 * a reciterdb-reachable client runs THIS export and uploads to S3; the importer —
 * run in-VPC as a normal `run-task` — reads it and writes Aurora.
 *
 * NDJSON contract: one JSON object per line, discriminated by `t`:
 *   { "t": "i", cwid, nctNumber, protocolNumber, piName, title, protocolType,
 *     firstOTADate, firstCTADate, statusDate, principalSponsor, overallCurrentStatus }
 *   { "t": "e", nctNumber, officialTitle, briefTitle, briefSummary, studyType,
 *     phases, conditions, meshTerms, enrollment }
 * Raw source rows — the importer applies the SAME join/role/build the direct ETL
 * does (etl/clinical-trials/shared.ts), so the bridge and direct paths can't drift.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   SCHOLARS_RECITERDB_*       (reciterdb connection; already in ~/.zshrc on a
 *                              reciterdb-reachable host)
 *   CLINICAL_TRIALS_BUCKET     (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   CLINICAL_TRIALS_KEY        (the S3 key; or pass `--key <key>`;
 *                              default clinical-trials/bridge.ndjson)
 *   AWS_DEFAULT_REGION         (default us-east-1)
 *
 * Usage (reciterdb-reachable client):
 *   npm run etl:clinical-trials:export
 *   npm run etl:clinical-trials:export -- --key clinical-trials/bridge.ndjson
 *   npm run etl:clinical-trials:export -- --dry-run   # read + count, no upload
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { closeReciterPool } from "@/lib/sources/reciterdb";
import { readReciterdbTables } from "./shared";

const BUCKET =
  process.env.CLINICAL_TRIALS_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "clinical-trials/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

/** Resolve the S3 key from `--key <key>` or CLINICAL_TRIALS_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.CLINICAL_TRIALS_KEY ?? DEFAULT_KEY;
}

async function main() {
  const start = Date.now();

  try {
    console.log("Loading clinical_trials + clinical_trials_enriched from reciterdb...");
    const { institutional, enriched } = await readReciterdbTables();
    console.log(
      `Fetched ${institutional.length} institutional rows, ${enriched.length} enriched rows.`,
    );

    const lines: string[] = [];
    for (const r of institutional) {
      lines.push(
        JSON.stringify({
          t: "i",
          cwid: r.cwid,
          nctNumber: r.nctNumber,
          protocolNumber: r.protocolNumber,
          piName: r.piName,
          title: r.title,
          protocolType: r.protocolType,
          firstOTADate: r.firstOTADate,
          firstCTADate: r.firstCTADate,
          statusDate: r.statusDate,
          principalSponsor: r.principalSponsor,
          overallCurrentStatus: r.overallCurrentStatus,
        }),
      );
    }
    for (const e of enriched) {
      lines.push(
        JSON.stringify({
          t: "e",
          nctNumber: e.nctNumber,
          officialTitle: e.officialTitle,
          briefTitle: e.briefTitle,
          briefSummary: e.briefSummary,
          studyType: e.studyType,
          phases: e.phases,
          conditions: e.conditions,
          meshTerms: e.meshTerms,
          enrollment: e.enrollment,
        }),
      );
    }
    const ndjson = lines.join("\n") + "\n";

    const key = resolveKey();
    if (dryRun) {
      console.log(
        `DRY-RUN: would upload ${institutional.length} institutional + ${enriched.length} enriched ` +
          `rows to s3://${BUCKET}/${key} (not written).`,
      );
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
      console.log(
        `Uploaded ${institutional.length} institutional + ${enriched.length} enriched rows ` +
          `to s3://${BUCKET}/${key}.`,
      );
    }

    if (institutional.length === 0) {
      console.warn(
        "WARNING: 0 institutional rows fetched — verify the SCHOLARS_RECITERDB_* env and " +
          "reciterdb reachability before trusting a clean run (the importer refuses to load " +
          "an empty export over good data, but don't rely on that).",
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
