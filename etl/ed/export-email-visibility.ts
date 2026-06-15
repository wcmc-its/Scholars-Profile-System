/**
 * Email-visibility EXPORT (bridge) — read the Web Directory email release code
 * from WCM ED LDAP and write `{ cwid, emailVisibility }` NDJSON to S3, for the
 * in-VPC importer (`import-email-visibility.ts`) to load into the environment's
 * Aurora `scholar.email_visibility` column.
 *
 * Why this exists: `email_visibility` is derived from the multi-valued LDAP
 * attribute `weillCornellEduReleaseCode;mail`, which lives ONLY in the WCM
 * directory. The normal `etl:ed` job reads it inline, but it is reachable from a
 * WCM-side client and NOT from the in-VPC ETL task (the SPS↔WCM networking is
 * not set up yet — #443; the in-VPC ED ETL fails at "Connecting to ED LDAP...
 * Error: Connection timeout"). Conversely the deployed environments' Aurora is
 * reachable only in-VPC. So neither side can do the read+write in one place.
 * This pair closes that gap, exactly like the COI-statements bridge
 * (`backfill-coi-statements.ts` + `import-coi-statements.ts`): a WCM-side client
 * runs THIS export against WCM LDAP and uploads the result to S3; the importer —
 * run in-VPC as a normal `run-task` — reads it and writes Aurora.
 *
 * Parity: this reads exactly what `etl:ed` reads. It calls the same
 * `fetchActiveFaculty()` projection, whose `emailVisibility` field is the same
 * `parseEmailReleaseAudience(weillCornellEduReleaseCode;mail)` value the ED ETL
 * persists to `Scholar.emailVisibility`. So the bridge backfills the identical
 * audience for the identical population the ED ETL would. CWIDs absent from this
 * projection (non-faculty branches) keep `email_visibility` NULL = 'none'
 * (fail-closed), which is also what a real ED ETL run leaves them.
 *
 * NDJSON contract: one JSON object per line — `{ cwid, emailVisibility }`, where
 * emailVisibility ∈ { "public", "institution", "none" }. The importer skips and
 * counts any malformed/invalid line.
 *
 * Env (AWS default credential chain — never hardcode keys):
 *   SCHOLARS_LDAP_URL / SCHOLARS_LDAP_BIND_DN / SCHOLARS_LDAP_BIND_PASSWORD
 *                              (the bind used by openLdap(); already in ~/.zshrc
 *                               on a WCM-side host)
 *   EMAIL_VISIBILITY_BUCKET    (default ARTIFACTS_BUCKET, else wcmc-reciterai-artifacts)
 *   EMAIL_VISIBILITY_KEY       (the S3 key; or pass `--key <key>`;
 *                               default ed/email-visibility/bridge.ndjson)
 *   AWS_DEFAULT_REGION         (default us-east-1)
 *
 * Usage (WCM-side / local, where LDAP is reachable):
 *   npm run etl:ed:export-email-visibility
 *   npm run etl:ed:export-email-visibility -- --key ed/email-visibility/bridge.ndjson
 *   npm run etl:ed:export-email-visibility -- --dry-run   # fetch + count, no upload
 */
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fetchActiveFaculty, openLdap, type EmailReleaseAudience } from "@/lib/sources/ldap";

const BUCKET =
  process.env.EMAIL_VISIBILITY_BUCKET ??
  process.env.ARTIFACTS_BUCKET ??
  "wcmc-reciterai-artifacts";
const REGION = process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const DEFAULT_KEY = "ed/email-visibility/bridge.ndjson";

const dryRun = process.argv.includes("--dry-run");

/** Resolve the S3 key from `--key <key>` or EMAIL_VISIBILITY_KEY (argv wins). */
function resolveKey(): string {
  const i = process.argv.indexOf("--key");
  const fromArgv = i >= 0 ? process.argv[i + 1] : undefined;
  return fromArgv ?? process.env.EMAIL_VISIBILITY_KEY ?? DEFAULT_KEY;
}

async function main() {
  const start = Date.now();

  console.log("Connecting to ED LDAP...");
  const client = await openLdap();
  let entries;
  try {
    entries = await fetchActiveFaculty(client);
  } finally {
    await client.unbind();
  }

  // One row per CWID (fetchActiveFaculty already returns one entry per CWID;
  // a Map makes last-wins explicit and drops any blank cwid defensively).
  const byCwid = new Map<string, EmailReleaseAudience>();
  for (const e of entries) {
    if (e.cwid) byCwid.set(e.cwid, e.emailVisibility);
  }

  const dist: Record<EmailReleaseAudience, number> = { public: 0, institution: 0, none: 0 };
  for (const v of byCwid.values()) dist[v]++;
  console.log(
    `Fetched ${byCwid.size} CWIDs from ${entries.length} LDAP entries ` +
      `(public=${dist.public}, institution=${dist.institution}, none=${dist.none}).`,
  );

  const ndjson =
    Array.from(byCwid, ([cwid, emailVisibility]) => JSON.stringify({ cwid, emailVisibility })).join(
      "\n",
    ) + "\n";

  const key = resolveKey();
  if (dryRun) {
    console.log(`DRY-RUN: would upload ${byCwid.size} rows to s3://${BUCKET}/${key} (not written).`);
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
    console.log(`Uploaded ${byCwid.size} rows to s3://${BUCKET}/${key}.`);
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`${dryRun ? "DRY-RUN " : ""}Export complete in ${elapsed}s.`);
  if (byCwid.size === 0) {
    console.warn(
      "WARNING: 0 CWIDs fetched — verify the LDAP bind and SCHOLARS_LDAP_* env " +
        "before trusting a clean run (do not import an empty NDJSON over good data).",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    // openLdap unbinds above; no DB connection is opened by the export half.
  });
