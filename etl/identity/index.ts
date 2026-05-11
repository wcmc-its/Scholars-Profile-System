/**
 * Identity ETL — Issue #171.
 *
 * Backfills `scholar.orcid` from the WCM Identity DynamoDB table, keyed by
 * `uid` (= CWID, lowercase). Only scholars carrying a non-null, well-formed
 * ORCID in Identity get their row updated; everyone else is left null.
 *
 * Identity record shape (sample):
 *   {
 *     uid: "meb7002",
 *     primaryName: { ... },
 *     orcid: "0000-0002-1825-0097" | null,
 *     ...other identity fields we don't read here
 *   }
 *
 * Strategy:
 *   1. Scan the Identity table with a filter that projects only the keys we
 *      need (uid, orcid). Skips records with orcid: null at the server.
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
import { prisma } from "../../lib/db";

const TABLE = process.env.SCHOLARS_IDENTITY_TABLE ?? "Identity";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

/** ORCID iD canonical form: 16 digits in 4-char groups, optional 'X' on the
 *  final check digit. Matches the bare-id form we store (no protocol/host). */
const ORCID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

type IdentityRow = {
  uid?: string;
  orcid?: string | null;
};

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
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
          // Server-side filter cuts the scan payload roughly in half — most
          // identity rows have orcid: null.
          FilterExpression: "attribute_exists(orcid) AND orcid <> :null",
          ExpressionAttributeValues: { ":null": null },
          ProjectionExpression: "uid, orcid",
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const it of (resp.Items ?? []) as IdentityRow[]) rows.push(it);
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    console.log(`Identity scan returned ${rows.length} record(s) with an ORCID.`);

    // Pre-load active Scholar cwids so we don't issue updates for rows that
    // would no-op (and so we can report unmatched Identity records).
    const ourScholars = await prisma.scholar.findMany({
      where: { deletedAt: null },
      select: { cwid: true, orcid: true },
    });
    const cwidToCurrent = new Map(ourScholars.map((s) => [s.cwid, s.orcid]));

    let updated = 0;
    let unchanged = 0;
    let invalidFormat = 0;
    let noScholar = 0;

    for (const row of rows) {
      const uid = typeof row.uid === "string" ? row.uid.trim() : "";
      const orcid = typeof row.orcid === "string" ? row.orcid.trim() : "";
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
      await prisma.scholar.update({
        where: { cwid: uid },
        data: { orcid },
      });
      updated += 1;
    }

    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `Identity ETL complete in ${took}s: ${updated} updated, ${unchanged} unchanged, ${invalidFormat} invalid, ${noScholar} no-scholar-row.`,
    );

    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        completedAt: new Date(),
        rowsProcessed: updated,
      },
    });
  } catch (err) {
    console.error("Identity ETL failed:", err);
    await prisma.etlRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
