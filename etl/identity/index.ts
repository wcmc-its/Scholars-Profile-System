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
 *   3. For every Scholar whose cwid matches a uid, update the orcid column.
 *      Scholars without a matching Identity row keep their existing orcid
 *      value — we do NOT NULL-out on absence, since Identity may lag behind
 *      ED (the system of record for who is an active scholar).
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

/** The Identity `uid` as a Scholar cwid: Identity stores it lowercase ("meb7002"),
 *  `scholar.cwid` is UPPERCASE ("MEB7002") -- the first nightly after #2676 read 3,794
 *  ORCIDs and matched 0 scholars on the exact-case Map lookup. "" when absent. Most
 *  Identity uids are Ithaca NetIDs (aa999 / aaa99 ...) that never match a scholar;
 *  only the aaa9999-shaped ~5% are WCM CWIDs. */
export function cwidFromIdentityItem(row: IdentityRow): string {
  return typeof row.uid === "string" ? row.uid.trim().toUpperCase() : "";
}

/** The trimmed ORCID string off an Identity item, or "" when absent / not a string. */
export function orcidFromIdentityItem(row: IdentityRow): string {
  const v = row.identity?.orcid;
  return typeof v === "string" ? v.trim() : "";
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
      select: { cwid: true, orcid: true },
    });
    const cwidToCurrent = new Map(ourScholars.map((s) => [s.cwid, s.orcid]));

    let updated = 0;
    let unchanged = 0;
    let invalidFormat = 0;
    let noScholar = 0;

    for (const row of rows) {
      const uid = cwidFromIdentityItem(row);
      const orcid = orcidFromIdentityItem(row);
      if (!uid || !orcid) continue;
      if (!ORCID_PATTERN.test(orcid)) {
        invalidFormat += 1;
        continue;
      }
      if (!cwidToCurrent.has(uid)) {
        noScholar += 1;
        continue;
      }
      if (cwidToCurrent.get(uid) === orcid) {
        unchanged += 1;
        continue;
      }
      await db.write.scholar.update({
        where: { cwid: uid },
        data: { orcid },
      });
      updated += 1;
    }

    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Identity ETL complete in ${took}s: ${updated} updated, ${unchanged} unchanged, ${invalidFormat} invalid, ${noScholar} no-scholar-row.`,
    );

    await db.write.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: updated,
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
