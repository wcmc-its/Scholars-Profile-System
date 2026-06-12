/**
 * AOC / med-student mentee IMPORT (bridge) — issue #928.
 *
 * Loads the `aoc_mentee` table from an NDJSON object on S3 (produced WCM-side
 * by `etl:mentoring:export-copubs`) instead of from the live ReciterDB
 * `reporting_students_mentors` query, which the in-VPC app can't reach. Run
 * in-VPC as a normal `run-task`. Idempotent / safe to re-run.
 *
 * The rows are a RAW mirror of `reporting_students_mentors` (a (mentor, mentee)
 * pair can repeat across programs), with no natural per-pair upsert key, so
 * this is a full TRUNCATE-and-LOAD: `deleteMany({})` then chunked `createMany`,
 * wrapped in ONE interactive transaction so a mid-import failure rolls back to
 * the prior contents (no partial table) and readers never observe an empty
 * window — the swap is atomic at commit.
 *
 * Empty-export floor guard: a 0-row parse ABORTS before the delete (the most
 * likely cause is a corrupt/partial/wrong-key S3 object, not a genuinely empty
 * roster), so a bad artifact can't wipe a populated table. Pass `--allow-empty`
 * to override when an intentional clear is desired.
 *
 * Once the table is populated, the read layer uses it when
 * `MENTORING_COPUB_BRIDGE=on` (import-then-flip). No FK to scholar (AOC students
 * are frequently unlinked alumni, GH #181), so no per-env existence filtering.
 *
 * NDJSON contract: one object per RAW reporting_students_mentors row —
 *   { mentorCwid, menteeCwid, firstName, lastName, graduationYear, programType }
 * (any of name/year/programType may be null; duplicate pairs allowed). Blank
 * lines are skipped; a line missing mentorCwid/menteeCwid is skipped + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET  (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_AOC_KEY        (default mentoring/aoc-mentees.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *
 * Usage:
 *   npm run etl:mentoring:import-aoc
 *   npm run etl:mentoring:import-aoc -- --key mentoring/aoc-mentees.ndjson
 *   npm run etl:mentoring:import-aoc -- --dry-run      # parse only
 *   npm run etl:mentoring:import-aoc -- --allow-empty  # permit a 0-row clear
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";

const BUCKET =
  process.env.MENTORING_COPUBS_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const INSERT_BATCH = 1000;

const dryRun = process.argv.includes("--dry-run");
const allowEmpty = process.argv.includes("--allow-empty");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.MENTORING_AOC_KEY ?? "mentoring/aoc-mentees.ndjson";
}

type Row = {
  mentorCwid: string;
  menteeCwid: string;
  firstName: string | null;
  lastName: string | null;
  graduationYear: number | null;
  programType: string | null;
};

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Parse NDJSON → validated rows. Returns rows + a skipped-line count. */
function parseNdjson(text: string): { rows: Row[]; skipped: number } {
  const rows: Row[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Partial<Row>;
      const mentorCwid = typeof o.mentorCwid === "string" ? o.mentorCwid.trim() : "";
      const menteeCwid = typeof o.menteeCwid === "string" ? o.menteeCwid.trim() : "";
      if (!mentorCwid || !menteeCwid) {
        skipped++;
        continue;
      }
      const firstName = typeof o.firstName === "string" ? o.firstName : null;
      const lastName = typeof o.lastName === "string" ? o.lastName : null;
      const graduationYear =
        typeof o.graduationYear === "number" && Number.isFinite(o.graduationYear)
          ? o.graduationYear
          : null;
      const programType = typeof o.programType === "string" ? o.programType : null;
      rows.push({ mentorCwid, menteeCwid, firstName, lastName, graduationYear, programType });
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

async function main() {
  const start = Date.now();
  const importedAt = new Date();
  const key = resolveKey();
  const run = await db.write.etlRun.create({
    data: { source: "AOC-Mentee-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped } = parseNdjson(text);
    console.log(`Parsed ${rows.length} AOC mentee rows (${skipped} lines skipped).`);

    // Empty-export floor guard: refuse to wipe a populated table from a 0-row
    // artifact (corrupt/partial/wrong-key S3 object), which would clear every
    // mentor's AOC chips. `--allow-empty` overrides for an intentional clear.
    if (!dryRun && rows.length === 0 && !allowEmpty) {
      throw new Error(
        "0 AOC mentee rows parsed — refusing to truncate aoc_mentee. Verify the " +
          "NDJSON key and that the export ran; pass --allow-empty to clear intentionally.",
      );
    }

    let written = 0;
    if (!dryRun) {
      // Full TRUNCATE-and-LOAD wrapped in ONE interactive transaction: the rows
      // are a raw mirror with no natural per-pair upsert key, so we clear the
      // table then re-insert. The transaction makes the swap atomic — a failure
      // on any batch rolls back to the prior contents (no partial table), and
      // readers never see an empty window (they observe the old rows until
      // commit, then the new ones).
      await db.write.$transaction(
        async (tx) => {
          const cleared = await tx.aocMentee.deleteMany({});
          console.log(`Cleared ${cleared.count} existing rows.`);
          for (const batch of chunks(rows, INSERT_BATCH)) {
            await tx.aocMentee.createMany({
              data: batch.map((r) => ({
                mentorCwid: r.mentorCwid,
                menteeCwid: r.menteeCwid,
                firstName: r.firstName ?? null,
                lastName: r.lastName ?? null,
                graduationYear: Number.isFinite(r.graduationYear) ? r.graduationYear : null,
                programType: r.programType ?? null,
                refreshedAt: importedAt,
              })),
            });
            written += batch.length;
            if (written % (INSERT_BATCH * 10) === 0) console.log(`  ...${written}/${rows.length}`);
          }
        },
        // Generous bounds: a full reload of the raw roster is larger than a
        // single statement but still a one-off in-VPC task.
        { timeout: 120_000, maxWait: 30_000 },
      );
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: written },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `${dryRun ? "DRY-RUN " : ""}Import complete in ${elapsed}s: ${written} inserted ` +
        `(${rows.length} parsed, ${skipped} skipped).`,
    );
    if (!dryRun && rows.length === 0) {
      console.warn(
        "WARNING: 0 AOC mentee rows parsed — verify the NDJSON key and that the export ran.",
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
