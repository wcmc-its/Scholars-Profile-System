/**
 * Learner FULL publication list import (bridge) — Mentored publications
 * report (`/edit/reports/7`), "All learner publications" mode.
 *
 * Loads the `aoc_mentee_publication` table (one row per (learner, pmid)) from
 * an NDJSON object on S3 (produced WCM-side by `etl:mentoring:export-copubs`,
 * product 4). MD-program learners are not Scholar rows in this app, so their
 * ReCiter-attributed publications exist only in ReciterDB, which the in-VPC
 * app can't reach; this is the mirror. Run in-VPC as a normal `run-task`.
 * Idempotent / safe to re-run. Full refresh: rows absent from this import (a
 * pmid no longer attributed, or a learner no longer on the roster) are deleted.
 *
 * The `pub` JSON is the same `CoPublicationFull` the co-pub bridge stores
 * (`mentee_copublication_pub`), built by the same export code, so the report
 * marks the mentored subset by pmid alone. Stored PRE-suppression like its
 * sibling; the report is an /edit console surface, not a public page.
 *
 * NDJSON contract: one object per learner with >=1 publication —
 *   { menteeCwid, pubs: CoPublicationFull[] }
 * Blank lines are skipped; a line missing menteeCwid or whose `pubs` is not an
 * array is skipped + counted. The row key (`pmid`, a string since round 5) is
 * the pub's `id` — the SPS `Publication.pmid` key, `SCOPUS:…` for a
 * Scopus-only article — else `String(pmid)` for a positive-integer pmid (a
 * product written before round 5); a pub with neither is dropped and counted
 * separately (`droppedPubs`) so a malformed artifact is visible in the log
 * rather than silently lossy.
 *
 * Empty-export floor guard: a 0-row parse ABORTS before the delete-stale step
 * (which, with nothing upserted, would remove every row), so a corrupt/partial/
 * wrong-key S3 object can't wipe a populated table. Pass `--allow-empty` to
 * override for an intentional clear. (A mid-import batch failure is already
 * safe: it throws before delete-stale runs, leaving the prior rows intact.)
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET     (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_LEARNER_PUBS_KEY  (default mentoring/learner-pubs.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION          (default us-east-1)
 *
 * Usage:
 *   npm run etl:mentoring:import-learner-pubs
 *   npm run etl:mentoring:import-learner-pubs -- --key mentoring/learner-pubs.ndjson
 *   npm run etl:mentoring:import-learner-pubs -- --dry-run      # parse only
 *   npm run etl:mentoring:import-learner-pubs -- --allow-empty  # permit a 0-row clear
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db, disconnect } from "../../lib/db";
import { Prisma } from "@/lib/generated/prisma/client";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ?? process.env.ARTIFACTS_BUCKET ?? "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const UPSERT_BATCH = 500;

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.MENTORING_LEARNER_PUBS_KEY ?? "mentoring/learner-pubs.ndjson";
}

/** Flattened DB row: one (learner, pmid) with its raw `CoPublicationFull` JSON. */
export type LearnerPubDbRow = {
  menteeCwid: string;
  pmid: string;
  pubYear: number | null;
  pub: Prisma.InputJsonValue;
};

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/** The row key: `id` when present, else a positive-integer `pmid` (an old
 *  product), else null (dropped). */
function rowKey(pub: { id?: unknown; pmid?: unknown }): string | null {
  if (typeof pub.id === "string" && pub.id.length > 0 && pub.id.length <= 32) return pub.id;
  return isPositiveInt(pub.pmid) ? String(pub.pmid) : null;
}

/** Parse NDJSON → flattened (learner, pmid) rows. `skipped` counts whole lines
 *  dropped (bad JSON / missing cwid / non-array pubs); `droppedPubs` counts
 *  individual pubs dropped for a missing/invalid key. A learner repeating
 *  across lines (the export emits one line per learner, but a hand-edited
 *  artifact might not) collapses to one row per pmid — the LAST wins. Exported
 *  for its unit test; the S3 read and the writes stay in `main`. */
export function parseLearnerPubsNdjson(text: string): {
  rows: LearnerPubDbRow[];
  skipped: number;
  droppedPubs: number;
} {
  const byKey = new Map<string, LearnerPubDbRow>();
  let skipped = 0;
  let droppedPubs = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as { menteeCwid?: unknown; pubs?: unknown };
      const menteeCwid = typeof o.menteeCwid === "string" ? o.menteeCwid.trim() : "";
      if (!menteeCwid || !Array.isArray(o.pubs)) {
        skipped++;
        continue;
      }
      for (const pub of o.pubs as Array<{ id?: unknown; pmid?: unknown; year?: unknown }>) {
        const pmid = pub ? rowKey(pub) : null;
        if (pmid === null) {
          droppedPubs++; // a pub with no valid key — counted, not silently lost
          continue;
        }
        byKey.set(`${menteeCwid}::${pmid}`, {
          menteeCwid,
          pmid,
          pubYear: typeof pub.year === "number" ? pub.year : null,
          pub: pub as unknown as Prisma.InputJsonValue,
        });
      }
    } catch {
      skipped++;
    }
  }
  return { rows: [...byKey.values()], skipped, droppedPubs };
}

async function main() {
  const start = Date.now();
  const importedAt = new Date();
  const key = resolveKey();
  const run = await db.write.etlRun.create({
    data: { source: "Learner-Pubs-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped, droppedPubs } = parseLearnerPubsNdjson(text);
    console.log(
      `Parsed ${rows.length} learner-pub rows (${skipped} lines skipped, ${droppedPubs} pubs dropped for invalid key).`,
    );

    // Empty-export floor guard: with nothing upserted, the delete-stale step
    // below removes every row — refuse to do that from a 0-row artifact
    // (corrupt/partial/wrong-key S3 object). `--allow-empty` overrides.
    if (!dryRun && rows.length === 0 && !allowEmpty) {
      throw new Error(
        "0 learner-pub rows parsed — refusing to delete-stale every aoc_mentee_publication " +
          "row. Verify the NDJSON key and that the export ran; pass --allow-empty to clear.",
      );
    }

    let written = 0;
    if (!dryRun) {
      for (const batch of chunks(rows, UPSERT_BATCH)) {
        await db.write.$transaction(
          batch.map((r) =>
            db.write.aocMenteePublication.upsert({
              where: { menteeCwid_pmid: { menteeCwid: r.menteeCwid, pmid: r.pmid } },
              create: {
                menteeCwid: r.menteeCwid,
                pmid: r.pmid,
                pubYear: r.pubYear,
                pub: r.pub,
                refreshedAt: importedAt,
              },
              update: {
                pubYear: r.pubYear,
                pub: r.pub,
                refreshedAt: importedAt,
              },
            }),
          ),
        );
        written += batch.length;
        if (written % (UPSERT_BATCH * 10) === 0) console.log(`  ...${written}/${rows.length}`);
      }

      // Full refresh: drop rows not present in this import. Anything not
      // just-upserted still carries its prior, older `refreshedAt`.
      const stale = await db.write.aocMenteePublication.deleteMany({
        where: { refreshedAt: { lt: importedAt } },
      });
      console.log(`Deleted ${stale.count} stale rows (not in this import).`);
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: written },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `${dryRun ? "DRY-RUN " : ""}Import complete in ${elapsed}s: ${written} upserted ` +
        `(${rows.length} parsed, ${skipped} lines skipped, ${droppedPubs} pubs dropped).`,
    );
    if (!dryRun && rows.length === 0) {
      console.warn(
        "WARNING: 0 learner-pub rows parsed — verify the NDJSON key and that the export ran.",
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

// Import-safe: only run when invoked as a script, never when imported by vitest.
if (!process.env.VITEST) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await disconnect();
    });
}
