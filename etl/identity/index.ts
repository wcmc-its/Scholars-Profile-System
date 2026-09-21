/**
 * Identity ETL — Issue #171.
 *
 * Backfills `scholar.orcid` from the WCM Identity DynamoDB table, keyed by
 * `uid` (= CWID, lowercase). Only scholars carrying a non-null, well-formed
 * ORCID in Identity get their row updated; everyone else is left null.
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
 *      sides — see `cwidFromIdentityItem`), update the orcid column.
 *      Scholars without a matching Identity row keep their existing orcid
 *      value — we do NOT NULL-out on absence, since Identity may lag behind
 *      ED (the system of record for who is an active scholar). The scan
 *      filter in step 1 means a NULL-orcid Identity row is never even read,
 *      so absence can never overwrite anything here — including an iD the
 *      person confirmed in SPS (`orcidConfirmedAt` set) that the Institutional
 *      Client's rebuild has wiped from Identity (IC #155); `etl/orcid-push`
 *      puts that one back.
 *   4. Conflict rule: when Identity holds a non-null iD that DIFFERS from one
 *      the person confirmed in SPS, Identity WINS — it is the authority (a
 *      change made in Publication Manager lands there) — so the row takes
 *      Identity's value AND `orcidConfirmedAt` is cleared (the confirmation
 *      was of a different iD). Counted as `conflict` in the summary line;
 *      the values themselves are never logged.
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

const TABLE = process.env.SCHOLARS_IDENTITY_TABLE ?? "Identity";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

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
  orcidConfirmedAt: Date | null;
};

/** The per-row outcome, so the rule is testable without a client. `update` is the plain
 *  backfill (SPS had nothing, or an unconfirmed different value); `conflict` is the case the
 *  header's step 4 describes — the person confirmed a DIFFERENT iD in SPS, Identity wins and
 *  the confirmation is cleared. */
export type IdentityDecision =
  | { kind: "skip" }
  | { kind: "invalid" }
  | { kind: "no_scholar" }
  | { kind: "unchanged" }
  | { kind: "update"; cwid: string; orcid: string }
  | { kind: "conflict"; cwid: string; orcid: string };

/** Pure: one Identity item against SPS's current state. Never sees a NULL-orcid Identity
 *  row (the scan filter drops those), so it never has an "absent" branch — absence cannot
 *  overwrite anything, confirmed or not. */
export function decideIdentityRow(
  row: IdentityRow,
  scholars: ReadonlyMap<string, ScholarOrcidState>,
): IdentityDecision {
  const cwid = cwidFromIdentityItem(row);
  const orcid = orcidFromIdentityItem(row);
  if (!cwid || !orcid) return { kind: "skip" };
  if (!ORCID_PATTERN.test(orcid)) return { kind: "invalid" };
  const current = scholars.get(cwid);
  if (!current) return { kind: "no_scholar" };
  if (current.orcid === orcid) return { kind: "unchanged" };
  if (current.orcidConfirmedAt !== null) return { kind: "conflict", cwid, orcid };
  return { kind: "update", cwid, orcid };
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

    // Pre-load active Scholar cwids so we don't issue updates for rows that
    // would no-op (and so we can report unmatched Identity records).
    const ourScholars = await db.write.scholar.findMany({
      where: { deletedAt: null },
      select: { cwid: true, orcid: true, orcidConfirmedAt: true },
    });
    // Keyed LOWERCASE to match `cwidFromIdentityItem` (the collation is case-insensitive,
    // the JS Map is not). The `where` below still uses the row's own cwid.
    const cwidToCurrent = new Map<string, ScholarOrcidState & { cwid: string }>(
      ourScholars.map((s) => [
        s.cwid.toLowerCase(),
        { cwid: s.cwid, orcid: s.orcid, orcidConfirmedAt: s.orcidConfirmedAt },
      ]),
    );

    let updated = 0;
    let unchanged = 0;
    let invalidFormat = 0;
    let noScholar = 0;
    let conflict = 0;

    for (const row of rows) {
      const d = decideIdentityRow(row, cwidToCurrent);
      if (d.kind === "skip") continue;
      if (d.kind === "invalid") {
        invalidFormat += 1;
        continue;
      }
      if (d.kind === "no_scholar") {
        noScholar += 1;
        continue;
      }
      if (d.kind === "unchanged") {
        unchanged += 1;
        continue;
      }
      const target = cwidToCurrent.get(d.cwid)!.cwid;
      if (d.kind === "conflict") {
        // Identity wins (header step 4): take its value and drop the confirmation of the
        // other iD. Counted separately so the summary shows it happened; no values logged.
        await db.write.scholar.update({
          where: { cwid: target },
          data: { orcid: d.orcid, orcidConfirmedAt: null },
        });
        conflict += 1;
        continue;
      }
      await db.write.scholar.update({
        where: { cwid: target },
        data: { orcid: d.orcid },
      });
      updated += 1;
    }

    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Identity ETL complete in ${took}s: ${updated} updated, ${unchanged} unchanged, ${conflict} conflict (Identity won over an SPS confirmation), ${invalidFormat} invalid, ${noScholar} no-scholar-row.`,
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: updated + conflict,
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
