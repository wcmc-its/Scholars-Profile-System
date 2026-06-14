/**
 * Mentee co-publication IMPORT (bridge) — issue #443.
 *
 * Loads the `mentee_copublication` table from an NDJSON object on S3 (produced
 * WCM-side by `etl:mentoring:export-copubs`) instead of from the live ReciterDB
 * query, which the in-VPC app can't reach. Run in-VPC as a normal `run-task`.
 * Idempotent / safe to re-run. Full refresh: rows absent from this import (a
 * pair that dropped to zero co-pubs, or a removed mentee) are deleted. A 0-row
 * parse is REFUSED (it would delete-stale every row) unless `--allow-empty` is
 * passed — matching the sibling importers (import-aoc / import-copub-list /
 * import-citing), so a corrupt / wrong-key S3 object can't wipe a populated table.
 *
 * Once the table is populated, the read layer uses it when
 * `MENTORING_COPUB_BRIDGE=on` (import-then-flip). No FK to publication/scholar,
 * so no per-env existence filtering is needed.
 *
 * NDJSON contract: one object per line —
 *   { mentorCwid, menteeCwid, count, preview: [{ pmid, title, journal, year }] }
 * Blank lines are skipped; a line missing mentorCwid/menteeCwid/count is skipped
 * + counted.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   MENTORING_COPUBS_BUCKET  (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   MENTORING_COPUBS_KEY     (default mentoring/copubs.ndjson; or pass --key <key>)
 *   AWS_DEFAULT_REGION       (default us-east-1)
 *
 * Usage:
 *   npm run etl:mentoring:import-copubs
 *   npm run etl:mentoring:import-copubs -- --key mentoring/copubs.ndjson
 *   npm run etl:mentoring:import-copubs -- --dry-run      # parse only
 *   npm run etl:mentoring:import-copubs -- --allow-empty  # permit a 0-row clear
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
  return fromArgv ?? process.env.MENTORING_COPUBS_KEY ?? "mentoring/copubs.ndjson";
}

type PreviewItem = { pmid: number; title: string; journal: string | null; year: number | null };
type Row = { mentorCwid: string; menteeCwid: string; count: number; preview: PreviewItem[] };

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
      const count = typeof o.count === "number" && Number.isFinite(o.count) ? o.count : NaN;
      if (!mentorCwid || !menteeCwid || !Number.isFinite(count) || count <= 0) {
        skipped++;
        continue;
      }
      const preview = Array.isArray(o.preview) ? (o.preview as PreviewItem[]) : [];
      rows.push({ mentorCwid, menteeCwid, count, preview });
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
    data: { source: "Mentee-Copubs-Import", status: "running" },
  });
  try {
    console.log(`Reading s3://${BUCKET}/${key} ...`);
    const s3 = new S3Client({ region: REGION });
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const text = await resp.Body!.transformToString("utf-8");

    const { rows, skipped } = parseNdjson(text);
    console.log(`Parsed ${rows.length} co-pub pairs (${skipped} lines skipped).`);

    // Full-refresh safety floor: a 0-row parse (corrupt / partial / wrong-key S3
    // object, or an empty export because ReciterDB was unreachable WCM-side)
    // would delete-stale EVERY existing row below — wiping every mentor's co-pub
    // badge for live readers. Refuse unless --allow-empty, mirroring the sibling
    // importers (import-aoc / import-copub-list / import-citing). Thrown inside
    // the try so the etlRun is marked failed and the prior contents survive.
    if (!dryRun && rows.length === 0 && !allowEmpty) {
      throw new Error(
        "0 co-pub pairs parsed — refusing to delete-stale every mentee_copublication " +
          "row. Verify the NDJSON key and that the export ran; pass --allow-empty to clear intentionally.",
      );
    }

    let written = 0;
    if (!dryRun) {
      for (const batch of chunks(rows, UPSERT_BATCH)) {
        await db.write.$transaction(
          batch.map((r) =>
            db.write.menteeCopublication.upsert({
              where: {
                mentorCwid_menteeCwid: { mentorCwid: r.mentorCwid, menteeCwid: r.menteeCwid },
              },
              create: {
                mentorCwid: r.mentorCwid,
                menteeCwid: r.menteeCwid,
                count: r.count,
                preview: r.preview as unknown as Prisma.InputJsonValue,
                refreshedAt: importedAt,
              },
              update: {
                count: r.count,
                preview: r.preview as unknown as Prisma.InputJsonValue,
                refreshedAt: importedAt,
              },
            }),
          ),
        );
        written += batch.length;
        if (written % (UPSERT_BATCH * 10) === 0) console.log(`  ...${written}/${rows.length}`);
      }

      // Full refresh: drop rows not present in this import (pairs that fell to
      // zero co-pubs or whose mentee was removed). Anything not just-upserted
      // still carries its prior, older `refreshedAt`.
      const stale = await db.write.menteeCopublication.deleteMany({
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
        `(${rows.length} parsed, ${skipped} skipped).`,
    );
    if (!dryRun && rows.length === 0) {
      // Only reachable with --allow-empty (the floor guard above throws otherwise).
      console.warn(
        "WARNING: 0 co-pub pairs parsed with --allow-empty — mentee_copublication was cleared.",
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
