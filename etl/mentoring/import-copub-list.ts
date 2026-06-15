/**
 * Full mentor↔mentee co-publication LIST import (bridge) — issue #928.
 *
 * Loads the `mentee_copublication_pub` table (one row per (mentor, mentee,
 * pmid)) from an NDJSON object on S3 (produced WCM-side by
 * `etl:mentoring:export-copubs`) instead of from the live ReciterDB query in
 * `getCoPublications`, which the in-VPC app can't reach. Run in-VPC as a normal
 * `run-task`. Idempotent / safe to re-run. Full refresh: rows absent from this
 * import (a pmid no longer shared, or a removed mentee) are deleted.
 *
 * Stored PRE-suppression (the raw `pub` JSON is the full `CoPublicationFull`).
 * The read path re-applies local publication suppression, which is env-specific
 * and changes independently of this bridge.
 *
 * Once the table is populated, the read layer uses it when
 * `MENTORING_COPUB_BRIDGE=on` (import-then-flip). No FK to publication/scholar,
 * so no per-env existence filtering is needed.
 *
 * NDJSON contract: one object per (mentor, mentee) pair with >=1 co-pub —
 *   { mentorCwid, menteeCwid, pubs: CoPublicationFull[] }
 * Blank lines are skipped; a line missing mentorCwid/menteeCwid or whose `pubs`
 * is not an array is skipped + counted. A pub without a valid positive-integer
 * pmid is dropped and counted separately (`droppedPubs`) so a malformed artifact
 * is visible in the log rather than silently lossy.
 *
 * Empty-export floor guard: a 0-row parse ABORTS before the delete-stale step
 * (which, with nothing upserted, would remove every row), so a corrupt/partial/
 * wrong-key S3 object can't wipe a populated table. Pass `--allow-empty` to
 * override for an intentional clear. (A mid-import batch failure is already
 * safe: it throws before delete-stale runs, leaving the prior rows intact.)
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET    (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_COPUB_LIST_KEY   (default mentoring/copub-list.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION         (default us-east-1)
 *
 * Usage:
 *   npm run etl:mentoring:import-copub-list
 *   npm run etl:mentoring:import-copub-list -- --key mentoring/copub-list.ndjson
 *   npm run etl:mentoring:import-copub-list -- --dry-run      # parse only
 *   npm run etl:mentoring:import-copub-list -- --allow-empty  # permit a 0-row clear
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";
import { Prisma } from "@/lib/generated/prisma/client";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const UPSERT_BATCH = 500;

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.MENTORING_COPUB_LIST_KEY ?? "mentoring/copub-list.ndjson";
}

/** Flattened DB row: one (mentor, mentee, pmid) with its raw `CoPublicationFull` JSON. */
type DbRow = {
  mentorCwid: string;
  menteeCwid: string;
  pmid: number;
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

/** Parse NDJSON → flattened (mentor, mentee, pmid) rows. `skipped` counts whole
 *  lines dropped (bad JSON / missing cwid / non-array pubs); `droppedPubs` counts
 *  individual pubs dropped for a missing/invalid pmid, so per-pub data loss in a
 *  malformed artifact is visible rather than silent. */
function parseNdjson(text: string): { rows: DbRow[]; skipped: number; droppedPubs: number } {
  const rows: DbRow[] = [];
  let skipped = 0;
  let droppedPubs = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as {
        mentorCwid?: unknown;
        menteeCwid?: unknown;
        pubs?: unknown;
      };
      const mentorCwid = typeof o.mentorCwid === "string" ? o.mentorCwid.trim() : "";
      const menteeCwid = typeof o.menteeCwid === "string" ? o.menteeCwid.trim() : "";
      if (!mentorCwid || !menteeCwid || !Array.isArray(o.pubs)) {
        skipped++;
        continue;
      }
      for (const pub of o.pubs as Array<{ pmid?: unknown; year?: unknown }>) {
        if (!pub || !isPositiveInt(pub.pmid)) {
          droppedPubs++; // a pub with no valid pmid — counted, not silently lost
          continue;
        }
        rows.push({
          mentorCwid,
          menteeCwid,
          pmid: Number(pub.pmid),
          pubYear: typeof pub.year === "number" ? pub.year : null,
          pub: pub as unknown as Prisma.InputJsonValue,
        });
      }
    } catch {
      skipped++;
    }
  }
  return { rows, skipped, droppedPubs };
}

async function main() {
  const start = Date.now();
  const importedAt = new Date();
  const key = resolveKey();
  const run = await db.write.etlRun.create({
    data: { source: "Mentee-Copub-List-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped, droppedPubs } = parseNdjson(text);
    console.log(
      `Parsed ${rows.length} co-pub rows (${skipped} lines skipped, ${droppedPubs} pubs dropped for invalid pmid).`,
    );

    // Empty-export floor guard: with nothing upserted, the delete-stale step
    // below removes every row — refuse to do that from a 0-row artifact
    // (corrupt/partial/wrong-key S3 object). `--allow-empty` overrides.
    if (!dryRun && rows.length === 0 && !allowEmpty) {
      throw new Error(
        "0 co-pub rows parsed — refusing to delete-stale every mentee_copublication_pub " +
          "row. Verify the NDJSON key and that the export ran; pass --allow-empty to clear.",
      );
    }

    let written = 0;
    if (!dryRun) {
      for (const batch of chunks(rows, UPSERT_BATCH)) {
        await db.write.$transaction(
          batch.map((r) =>
            db.write.menteeCopublicationPub.upsert({
              where: {
                mentorCwid_menteeCwid_pmid: {
                  mentorCwid: r.mentorCwid,
                  menteeCwid: r.menteeCwid,
                  pmid: r.pmid,
                },
              },
              create: {
                mentorCwid: r.mentorCwid,
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

      // Full refresh: drop rows not present in this import (a pmid no longer
      // shared by the pair, or whose mentee was removed). Anything not
      // just-upserted still carries its prior, older `refreshedAt`.
      const stale = await db.write.menteeCopublicationPub.deleteMany({
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
        "WARNING: 0 co-pub rows parsed — verify the NDJSON key and that the export ran.",
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.write.$disconnect();
  });
