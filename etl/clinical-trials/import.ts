/**
 * Clinical-trials IMPORT (bridge half 2) — load `clinical_trial` +
 * `person_clinical_trial` from the NDJSON the export half wrote to S3, instead of
 * reading reciterdb directly.
 *
 * Why this exists: see export.ts. reciterdb is unreachable from the in-VPC ETL
 * task (#443); the Sps Aurora is reachable only in-VPC. The export runs on a
 * reciterdb-reachable client and uploads raw rows to S3; this importer — run
 * in-VPC as a normal `run-task` — reads them, applies the SAME join/role/build as
 * the direct ETL (etl/clinical-trials/shared.ts), and full-replaces the two
 * tables. Idempotent / safe to re-run.
 *
 * SAFETY: this full-replaces (delete-all + insert-all). An empty or corrupt
 * export would otherwise wipe good data, so the importer REFUSES to proceed when
 * the NDJSON yields 0 institutional rows (or 0 built trials) — pass
 * `--allow-empty` only to deliberately clear the tables.
 *
 * NDJSON contract: see export.ts (`{ t: "i" | "e", ... }` per line). Blank and
 * malformed lines are skipped + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   CLINICAL_TRIALS_BUCKET    (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   CLINICAL_TRIALS_KEY       (the S3 key; or pass `--key <key>`;
 *                             default clinical-trials/bridge.ndjson)
 *   AWS_DEFAULT_REGION        (default us-east-1)
 *
 * Usage (in-VPC run-task):
 *   npm run etl:clinical-trials:import
 *   npm run etl:clinical-trials:import -- --key clinical-trials/bridge.ndjson
 *   npm run etl:clinical-trials:import -- --dry-run      # parse + build + count, no DB writes
 *   npm run etl:clinical-trials:import -- --allow-empty  # permit clearing the tables
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import {
  buildTrialsAndLinks,
  loadScholars,
  replaceAll,
  type EnrichedRow,
  type InstitutionalRow,
} from "./shared";

const BUCKET =
  process.env.CLINICAL_TRIALS_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "clinical-trials/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

/** Resolve the S3 key from `--key <key>` or CLINICAL_TRIALS_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.CLINICAL_TRIALS_KEY ?? DEFAULT_KEY;
}

/** Parse the discriminated NDJSON back into the two raw row arrays. */
function parseNdjson(text: string): {
  institutional: InstitutionalRow[];
  enriched: EnrichedRow[];
  skipped: number;
} {
  const institutional: InstitutionalRow[] = [];
  const enriched: EnrichedRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as { t?: string } & Record<string, unknown>;
      if (o.t === "i") {
        institutional.push({
          cwid: (o.cwid as string) ?? null,
          nctNumber: (o.nctNumber as string) ?? null,
          protocolNumber: (o.protocolNumber as string) ?? null,
          piName: (o.piName as string) ?? null,
          title: (o.title as string) ?? null,
          protocolType: (o.protocolType as string) ?? null,
          firstOTADate: (o.firstOTADate as string) ?? null,
          firstCTADate: (o.firstCTADate as string) ?? null,
          statusDate: (o.statusDate as string) ?? null,
          principalSponsor: (o.principalSponsor as string) ?? null,
          overallCurrentStatus: (o.overallCurrentStatus as string) ?? null,
        });
      } else if (o.t === "e") {
        enriched.push({
          nctNumber: (o.nctNumber as string) ?? null,
          officialTitle: (o.officialTitle as string) ?? null,
          briefTitle: (o.briefTitle as string) ?? null,
          briefSummary: (o.briefSummary as string) ?? null,
          studyType: (o.studyType as string) ?? null,
          phases: (o.phases as string) ?? null,
          conditions: (o.conditions as string) ?? null,
          meshTerms: (o.meshTerms as string) ?? null,
          enrollment: (o.enrollment as number | string) ?? null,
        });
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { institutional, enriched, skipped };
}

async function main() {
  const start = Date.now();
  const now = new Date();
  const key = resolveKey();

  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await resp.Body!.transformToString("utf-8");

  const { institutional, enriched, skipped } = parseNdjson(text);
  console.log(
    `Parsed ${institutional.length} institutional + ${enriched.length} enriched rows ` +
      `(${skipped} lines skipped).`,
  );

  // SAFETY: refuse to full-replace from an empty/corrupt export — that would
  // delete-all and insert-nothing, wiping good data. --allow-empty overrides.
  if (institutional.length === 0 && !allowEmpty) {
    throw new Error(
      "Refusing to import: 0 institutional rows parsed (would wipe existing trials). " +
        "Verify the S3 key/export, or pass --allow-empty to deliberately clear the tables.",
    );
  }

  const scholars = await loadScholars();
  const { trials, links, stats } = buildTrialsAndLinks(institutional, enriched, scholars, now);
  console.log(
    `Built ${stats.trials} trials (${stats.enrichedHits} had NCT enrichment) and ${stats.links} ` +
      `person links. Skipped ${stats.skippedNoProtocol} rows w/o protocolNumber, ` +
      `${stats.skippedUnknownCwid} w/ cwid not in this env's scholar set.`,
  );

  if (institutional.length > 0 && trials.length === 0 && !allowEmpty) {
    throw new Error(
      `Refusing to import: ${institutional.length} institutional rows but 0 trials built ` +
        "(join/scholar-set mismatch?). Pass --allow-empty to clear the tables anyway.",
    );
  }

  if (dryRun) {
    console.log("DRY-RUN: parsed + built only, no DB writes.");
    console.log(`DRY-RUN Import complete in ${Math.round((Date.now() - start) / 1000)}s.`);
    return;
  }

  const runRow = await db.write.etlRun.create({
    data: { source: "ClinicalTrials-Import", status: "running" },
  });
  try {
    const r = await replaceAll(trials, links);
    await db.write.etlRun.update({
      where: { id: runRow.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: r.insLinks },
    });
    console.log(
      `Import complete in ${Math.round((Date.now() - start) / 1000)}s: ` +
        `deleted ${r.delLinks} links / ${r.delTrials} trials, ` +
        `inserted ${r.insTrials} trials / ${r.insLinks} person links.`,
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
