/**
 * Email-visibility IMPORT (bridge) — load `scholar.email_visibility` from a
 * `{ cwid, emailVisibility }` NDJSON object on S3 instead of from WCM ED LDAP.
 *
 * Why this exists: `email_visibility` derives from the LDAP attribute
 * `weillCornellEduReleaseCode;mail`, which the in-VPC ED ETL cannot reach (the
 * SPS↔WCM networking is not set up yet — #443; `etl:ed` fails at "Connecting to
 * ED LDAP... Error: Connection timeout"). The companion export
 * (`export-email-visibility.ts`) runs WCM-side, reads LDAP, and uploads the
 * NDJSON to S3; this importer — run in-VPC as a normal `run-task` — reads that
 * NDJSON and writes the environment's Aurora. Idempotent / safe to re-run.
 *
 * It writes the SAME audience value, for the SAME population, that an in-VPC
 * `etl:ed` run would (see the export header for the parity argument). CWIDs not
 * present in the NDJSON are left untouched: their `email_visibility` stays NULL,
 * which the email-release gate treats as 'none' (fail-closed). The gate flag
 * (`PROFILE_EMAIL_RELEASE_GATE`) must only be flipped on AFTER this import lands
 * — reindex-then-flip discipline (docs/email-visibility-spec.md).
 *
 * NDJSON contract: one JSON object per line — `{ cwid, emailVisibility }`, where
 * emailVisibility ∈ { "public", "institution", "none" }. Blank lines are skipped;
 * a line missing cwid or carrying an out-of-range audience is skipped + counted.
 * Matching is case-insensitive (the `cwid` column collation is `_ci`).
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   EMAIL_VISIBILITY_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   EMAIL_VISIBILITY_KEY      (the S3 key; or pass `--key <key>`;
 *                              default ed/email-visibility/bridge.ndjson)
 *   AWS_DEFAULT_REGION        (default us-east-1)
 *
 * Usage (in-VPC run-task):
 *   npm run etl:ed:import-email-visibility
 *   npm run etl:ed:import-email-visibility -- --key ed/email-visibility/bridge.ndjson
 *   npm run etl:ed:import-email-visibility -- --dry-run   # parse + count only, no DB
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";

const BUCKET =
  process.env.EMAIL_VISIBILITY_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ed/email-visibility/bridge.ndjson";
const IN_BATCH = 1000;

const AUDIENCES = ["public", "institution", "none"] as const;
type Audience = (typeof AUDIENCES)[number];
const isAudience = (v: unknown): v is Audience =>
  typeof v === "string" && (AUDIENCES as readonly string[]).includes(v);

const dryRun = process.argv.includes("--dry-run");

/** Resolve the S3 key from `--key <key>` or EMAIL_VISIBILITY_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.EMAIL_VISIBILITY_KEY ?? DEFAULT_KEY;
}

type Row = { cwid: string; emailVisibility: Audience };

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Parse NDJSON → validated rows. Last value wins per cwid. Returns rows +
 *  a skipped-line count. */
function parseNdjson(text: string): { rows: Row[]; skipped: number } {
  const byCwid = new Map<string, Audience>();
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const o = JSON.parse(trimmed) as Partial<Row>;
      const cwid = o.cwid != null ? String(o.cwid).trim() : "";
      if (cwid === "" || !isAudience(o.emailVisibility)) {
        skipped++;
        continue;
      }
      byCwid.set(cwid, o.emailVisibility);
    } catch {
      skipped++;
    }
  }
  return { rows: Array.from(byCwid, ([cwid, emailVisibility]) => ({ cwid, emailVisibility })), skipped };
}

async function main() {
  const start = Date.now();
  const key = resolveKey();

  console.log(`Reading s3://${BUCKET}/${key} ...`);
  const s3 = new S3Client({ region: REGION });
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await resp.Body!.transformToString("utf-8");

  const { rows, skipped } = parseNdjson(text);
  const parsedDist: Record<Audience, number> = { public: 0, institution: 0, none: 0 };
  for (const r of rows) parsedDist[r.emailVisibility]++;
  console.log(
    `Parsed ${rows.length} rows (${skipped} skipped) — ` +
      `public=${parsedDist.public}, institution=${parsedDist.institution}, none=${parsedDist.none}.`,
  );

  if (dryRun) {
    console.log("DRY-RUN: parsed only, no DB writes.");
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`DRY-RUN Import complete in ${elapsed}s.`);
    if (rows.length === 0) {
      console.warn("WARNING: 0 rows parsed — verify the NDJSON key before a real run.");
    }
    return;
  }

  const run = await db.write.etlRun.create({
    data: { source: "ED-EmailVisibility-Import", status: "running" },
  });
  try {
    // One updateMany per audience value, chunked on the cwid IN-list. Rows whose
    // cwid is absent from `scholar` simply match nothing (no-op) — the same
    // "filter to the target's keys" posture as import-coi-statements.ts, achieved
    // here implicitly because updateMany only touches existing rows.
    let updated = 0;
    const updatedByValue: Record<Audience, number> = { public: 0, institution: 0, none: 0 };
    for (const value of AUDIENCES) {
      const cwids = rows.filter((r) => r.emailVisibility === value).map((r) => r.cwid);
      for (const batch of chunks(cwids, IN_BATCH)) {
        const res = await db.write.scholar.updateMany({
          where: { cwid: { in: batch } },
          data: { emailVisibility: value },
        });
        updated += res.count;
        updatedByValue[value] += res.count;
      }
    }

    await db.write.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: updated },
    });
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(
      `Import complete in ${elapsed}s: ${updated} scholars updated ` +
        `(public=${updatedByValue.public}, institution=${updatedByValue.institution}, ` +
        `none=${updatedByValue.none}) of ${rows.length} rows ` +
        `(${rows.length - updated} rows had no matching scholar).`,
    );
    if (updated === 0) {
      console.warn(
        "WARNING: 0 scholars updated — verify the NDJSON key and that the CWIDs " +
          "match this env's scholar table before trusting a clean run.",
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
