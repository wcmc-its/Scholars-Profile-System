/**
 * Identity ETL — Issue #171.
 *
 * Offers the iDs in the WCM Identity DynamoDB table, keyed by `uid` (= CWID,
 * lowercase), to the ORCID queue as `orcid_candidate` rows with
 * `source = 'identity'`. It never writes `scholar.orcid`: Scholars is the ORCID
 * authority for its scholars, and `etl/orcid-push` makes Identity match Scholars,
 * not the other way round. Until 2026-10 this step copied Identity's iD into
 * `scholar.orcid` and, on a conflict, let Identity win over a Scholars
 * confirmation.
 *
 * Identity record shape (OBSERVED 2026-09-18 via a names-only scan — the ORCID is NESTED
 * under an `identity` map, not top-level; the earlier top-level sample was assumed and the
 * scan matched 0 rows for months while grading green, see #2675):
 *   {
 *     uid: "meb7002",
 *     identity: {
 *       uid: "meb7002",
 *       primaryName: { ... },
 *       orcid: "0000-0002-1825-0097" | NULL,   // DynamoDB NULL type when absent
 *       ...other identity fields we don't read here
 *     }
 *   }
 *
 * Strategy:
 *   1. Scan the Identity table with a filter that projects only the keys we
 *      need (uid, identity.orcid). `attribute_type(identity.orcid, S)` keeps only
 *      string-typed values server-side — a typed NULL never matches, and a
 *      `<>` against a NULL-typed operand would be a cross-type comparison.
 *   2. Validate each ORCID string against the canonical 19-char form
 *      (16 digits in 4-char groups, with an optional 'X' check digit).
 *   3. For every Scholar whose cwid matches a uid (compared LOWERCASE on both
 *      sides — see `cwidFromIdentityItem`): an iD equal to `scholar.orcid` is
 *      `unchanged`; any other iD (Scholars holds none, or a different one,
 *      confirmed or not) is a `candidate`, for a librarian to decide in the queue.
 *   4. Dismissal rule: a pair the person said "Not me" to (`orcid_dismissal`)
 *      is never offered again, even while Identity still holds it (the push
 *      clears it there). Counted as `dismissed`.
 *   5. Mirror: the `identity` rows are upserted and every older `identity` row is
 *      deleted, scoped to that source, so `etl/orcid-candidates` and
 *      `etl/orcid-registry` rows are never touched. A scan that returns no iD at
 *      all is an outage, and the run fails before the delete.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or AWS_REGION)
 *   SCHOLARS_IDENTITY_TABLE  (default: Identity)
 *
 * Usage: `npm run etl:identity`
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { db } from "../../lib/db";

/** The WCM Identity table and region. etl/orcid-evidence scans the same table
 *  (each record's `identity.institutions`), with the same config. */
export const IDENTITY_TABLE = process.env.SCHOLARS_IDENTITY_TABLE ?? "Identity";
export const IDENTITY_REGION =
  process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const TABLE = IDENTITY_TABLE;
const REGION = IDENTITY_REGION;

/** The `orcid_candidate.source` this step owns; its delete pass touches no other. */
export const IDENTITY_SOURCE = "identity";
const BATCH = 500;

/** ORCID iD canonical form: 16 digits in 4-char groups, optional 'X' on the
 *  final check digit. Matches the bare-id form we store (no protocol/host). */
const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

type IdentityRow = {
  uid?: string;
  identity?: { orcid?: string | null } | null;
};

/** The scan's server-side shape: only rows whose NESTED `identity.orcid` is a string, and
 *  only the two attributes the ETL reads. `identity` is aliased through
 *  ExpressionAttributeNames so a reserved-word collision can never bite. */
export const IDENTITY_ORCID_SCAN = {
  FilterExpression: "attribute_type(#identity.orcid, :s)",
  ProjectionExpression: "uid, #identity.orcid",
  ExpressionAttributeNames: { "#identity": "identity" },
  ExpressionAttributeValues: { ":s": "S" },
} as const;

/** The Identity `uid` as a Scholar cwid: Identity stores it lowercase ("meb7002") and so
 *  does `scholar.cwid` (10,814 of 10,815 rows on the prod-shaped dump, binary compare).
 *  #2682 UPPERCASED it here, reasoning from the one odd row, and so matched NOTHING —
 *  the Map lookup below is case-sensitive even though the column's collation is not.
 *  Lowercase both sides (the scholar Map is keyed by `cwid.toLowerCase()` too, so the one
 *  uppercase row still matches). "" when absent. Most Identity uids are Ithaca NetIDs
 *  (aa999 / aaa99 ...) that never match a scholar; only the aaa9999-shaped ~5% are WCM CWIDs. */
export function cwidFromIdentityItem(row: IdentityRow): string {
  return typeof row.uid === "string" ? row.uid.trim().toLowerCase() : "";
}

/** The trimmed ORCID string off an Identity item, or "" when absent / not a string. */
export function orcidFromIdentityItem(row: IdentityRow): string {
  const v = row.identity?.orcid;
  return typeof v === "string" ? v.trim() : "";
}

/** What SPS currently holds for a scholar, keyed by lowercase cwid in the Map below. */
export type ScholarOrcidState = {
  orcid: string | null;
};

/** The per-row outcome, so the rule is testable without a client. `candidate` is an iD
 *  Scholars does not hold (none on file, or a different one); `dismissed` is step 4 — the
 *  person said "Not me" to exactly this iD. `cwid` on `candidate` is the scholar's own
 *  spelling, for the FK. */
export type IdentityDecision =
  | { kind: "skip" }
  | { kind: "invalid" }
  | { kind: "no_scholar" }
  | { kind: "dismissed" }
  | { kind: "unchanged" }
  | { kind: "candidate"; cwid: string; orcid: string };

/** The Set key for one (cwid, orcid) dismissal pair; cwid lowercased to match the Map. */
export function dismissalKey(cwid: string, orcid: string): string {
  return `${cwid.toLowerCase()}\u0000${orcid}`;
}

/** Pure: one Identity item against SPS's current state. Never sees a NULL-orcid Identity
 *  row (the scan filter drops those). `dismissed` = the `orcid_dismissal` pairs, keyed by
 *  `dismissalKey`; checked before `unchanged` so a contradicted row (SPS somehow holds the
 *  dismissed iD) still reads `dismissed`. */
export function decideIdentityRow(
  row: IdentityRow,
  scholars: ReadonlyMap<string, ScholarOrcidState & { cwid?: string }>,
  dismissed: ReadonlySet<string> = new Set(),
): IdentityDecision {
  const cwid = cwidFromIdentityItem(row);
  const orcid = orcidFromIdentityItem(row);
  if (!cwid || !orcid) return { kind: "skip" };
  if (!ORCID_PATTERN.test(orcid)) return { kind: "invalid" };
  const current = scholars.get(cwid);
  if (!current) return { kind: "no_scholar" };
  if (dismissed.has(dismissalKey(cwid, orcid))) return { kind: "dismissed" };
  if (current.orcid === orcid) return { kind: "unchanged" };
  return { kind: "candidate", cwid: current.cwid ?? cwid, orcid };
}

async function main() {
  const start = Date.now();
  const run = await db.write.etlRun.create({
    data: { source: "Identity-orcid", status: "running" },
  });

  try {
    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

    console.log(`Scanning ${TABLE} for records with non-null orcid...`);
    const rows: IdentityRow[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const resp = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          // Server-side filter: only rows carrying a string ORCID (most carry a typed
          // NULL), and only the two attributes read below.
          ...IDENTITY_ORCID_SCAN,
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const it of (resp.Items ?? []) as IdentityRow[]) rows.push(it);
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    console.log(`Identity scan returned ${rows.length} record(s) with an ORCID.`);
    // Fail loud rather than wipe the `identity` candidates: an empty scan is an outage.
    if (rows.length === 0) throw new Error("0 Identity rows with an ORCID — refusing to mirror");

    const ourScholars = await db.write.scholar.findMany({
      where: { deletedAt: null },
      select: { cwid: true, orcid: true },
    });
    // Keyed LOWERCASE to match `cwidFromIdentityItem` (the collation is case-insensitive,
    // the JS Map is not). The candidate row still uses the scholar's own cwid.
    const cwidToCurrent = new Map(ourScholars.map((s) => [s.cwid.toLowerCase(), s]));

    const dismissalRows = await db.write.orcidDismissal.findMany({
      select: { cwid: true, orcid: true },
    });
    const dismissed = new Set(dismissalRows.map((d) => dismissalKey(d.cwid, d.orcid)));

    const counts = { candidate: 0, unchanged: 0, dismissed: 0, invalid: 0, no_scholar: 0 };
    const keep: Array<{ cwid: string; orcid: string }> = [];
    for (const row of rows) {
      const d = decideIdentityRow(row, cwidToCurrent, dismissed);
      if (d.kind === "skip") continue;
      counts[d.kind] += 1;
      if (d.kind === "candidate") keep.push({ cwid: d.cwid, orcid: d.orcid });
    }

    const now = new Date();
    for (let i = 0; i < keep.length; i += BATCH) {
      await db.write.$transaction(
        keep.slice(i, i + BATCH).map((r) =>
          db.write.orcidCandidate.upsert({
            where: { cwid_orcid_source: { ...r, source: IDENTITY_SOURCE } },
            create: { ...r, source: IDENTITY_SOURCE, syncedAt: now },
            update: { syncedAt: now },
          }),
        ),
      );
    }
    const { count: removed } = await db.write.orcidCandidate.deleteMany({
      where: { source: IDENTITY_SOURCE, syncedAt: { lt: now } },
    });

    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Identity ETL complete in ${took}s: ${counts.candidate} candidate (Identity holds an iD Scholars does not), ${counts.unchanged} unchanged, ${counts.dismissed} dismissed (Not-me pair, not offered), ${counts.invalid} invalid, ${counts.no_scholar} no-scholar-row; ${removed} stale identity candidate(s) removed.`,
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: keep.length,
      },
    });
  } catch (err) {
    console.error("Identity ETL failed:", err);
    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    process.exitCode = 1;
  } finally {
    await db.write.$disconnect();
  }
}

// Run only when invoked directly (`npm run etl:identity` / the nightly task) — the module is
// also imported by its unit test for the scan shape + item reader.
const isDirectInvocation =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) main();
