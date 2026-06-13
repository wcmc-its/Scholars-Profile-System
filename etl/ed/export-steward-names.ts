/**
 * Steward-name EXPORT (bridge) — read display names for the `comms_steward`
 * CWIDs from WCM ED LDAP and write `{ cwid, displayName }` NDJSON to S3, for the
 * in-VPC importer (`import-steward-names.ts`) to load into `steward_directory`.
 *
 * Why this exists: a comms_steward (e.g. dwd2001) is external-affairs staff with
 * no `Scholar` row, so the "View as" banner + candidate list have no name to
 * show and fall back to the bare CWID. The name lives only in the WCM directory
 * (`ou=people`), which the in-VPC ETL cannot reach (#443 — same gap that forces
 * the steward allowlist). This pair closes it exactly like the email-visibility
 * bridge: a WCM-side client runs THIS export and uploads to S3; the importer —
 * run in-VPC as a normal `run-task` — reads it and writes Aurora.
 *
 * Population: the configured steward allowlist (`SCHOLARS_COMMS_STEWARD_ALLOWLIST`,
 * comma-separated CWIDs). Read DIRECTLY here, NOT via `listCommsStewardCwids()`,
 * which is gated by `COMMS_STEWARD_ENABLED` — the operator exports names for the
 * configured stewards regardless of the runtime kill switch. (Group-CN
 * enumeration is a future addition; today the allowlist is the source.)
 *
 * NDJSON contract: one object per line — `{ cwid, displayName }`. A CWID whose
 * LDAP entry yields no usable name is skipped + counted (never written blank).
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   SCHOLARS_LDAP_URL / SCHOLARS_LDAP_BIND_DN / SCHOLARS_LDAP_BIND_PASSWORD
 *   SCHOLARS_COMMS_STEWARD_ALLOWLIST   (the CWIDs to resolve)
 *   STEWARD_NAMES_BUCKET   (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   STEWARD_NAMES_KEY      (or `--key <key>`; default ed/steward-names/bridge.ndjson)
 *   AWS_DEFAULT_REGION     (default us-east-1)
 *
 * Usage (WCM-side / local, where LDAP is reachable):
 *   npm run etl:ed:export-steward-names
 *   npm run etl:ed:export-steward-names -- --dry-run   # fetch + count, no upload
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fetchPersonNamesByCwid } from "@/lib/sources/ldap";
import { buildStewardDisplayName } from "./steward-names";

const BUCKET =
  process.env.STEWARD_NAMES_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ed/steward-names/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.STEWARD_NAMES_KEY ?? DEFAULT_KEY;
}

/** The configured steward CWIDs (allowlist), lower-cased + de-duplicated. */
function stewardCwids(): string[] {
  const raw = process.env.SCHOLARS_COMMS_STEWARD_ALLOWLIST;
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0),
    ),
  ];
}

async function main() {
  const start = Date.now();

  const cwids = stewardCwids();
  if (cwids.length === 0) {
    console.warn(
      "No steward CWIDs configured (SCHOLARS_COMMS_STEWARD_ALLOWLIST is empty) — nothing to export.",
    );
    return;
  }
  console.log(`Resolving ${cwids.length} steward CWID(s) from ED LDAP...`);

  const names = await fetchPersonNamesByCwid(cwids);

  // One row per CWID with a usable name; missing/blank names skipped + counted.
  const rows: Array<{ cwid: string; displayName: string }> = [];
  let skipped = 0;
  for (const cwid of cwids) {
    const name = names.get(cwid);
    const dn = name ? buildStewardDisplayName(name) : "";
    if (dn === "") {
      skipped++;
      continue;
    }
    rows.push({ cwid, displayName: dn });
  }
  console.log(`Resolved ${rows.length} name(s) (${skipped} CWID(s) had no usable name).`);

  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const key = resolveKey();

  if (dryRun) {
    console.log(`DRY-RUN: would upload ${rows.length} rows to s3://${BUCKET}/${key} (not written).`);
    for (const r of rows) console.log(`  ${r.cwid} -> ${r.displayName}`);
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

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`${dryRun ? "DRY-RUN " : ""}Export complete in ${elapsed}s.`);
  if (rows.length === 0) {
    console.warn(
      "WARNING: 0 names resolved — verify the LDAP bind + SCHOLARS_LDAP_* env " +
        "before trusting a clean run (do not import an empty NDJSON).",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
