/**
 * probe-topic-fields — read-only diagnostic for the etl/dynamodb Block 2
 * "missing required fields" skip (issue #348).
 *
 * Reproduces index.ts Block 2's topic -> scholar -> required-fields skip
 * cascade against a full TOPIC# scan, then breaks the skippedMissingFields
 * bucket down by which field (pmid / score / year / author_position) is
 * absent and prints sample skipped records. Used to characterize how much
 * of the TOPIC# projection never reaches publication_topic, and why
 * (#348: ~52% are dropped for an empty author_position).
 *
 * Read-only: Prisma SELECTs (topic, scholar) + a DynamoDB scan. No writes,
 * no etl-run row.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or AWS_REGION)
 *   SCHOLARS_DYNAMODB_TABLE  (default: reciterai)
 *   DATABASE_URL
 *
 * Usage: npx tsx etl/dynamodb/probe-topic-fields.ts
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { prisma } from "../../lib/db";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

function stripCwidPrefix(raw: string): string {
  return raw.startsWith("cwid_") ? raw.slice("cwid_".length) : raw;
}

async function main() {
  const knownTopicIds = new Set(
    (await prisma.topic.findMany({ select: { id: true } })).map((t) => t.id),
  );
  const ourCwidSet = new Set(
    (
      await prisma.scholar.findMany({
        where: { deletedAt: null, status: "active" },
        select: { cwid: true },
      })
    ).map((s) => s.cwid),
  );
  console.log(`Loaded ${knownTopicIds.size} topic ids, ${ourCwidSet.size} active scholar cwids.`);

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": "TOPIC#" },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const it of resp.Items ?? []) items.push(it as Record<string, unknown>);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);
  console.log(`Scanned ${items.length} TOPIC# records.\n`);

  let passedTopicScholar = 0;
  let skippedMissingFields = 0;
  let validRows = 0;
  let missingPmid = 0;
  let missingScore = 0;
  let missingYear = 0;
  let missingAuthorPosition = 0;
  const missingCountHist = new Map<number, number>();
  const samples: Record<string, unknown>[] = [];

  for (const it of items) {
    const parentTopicId = String(it.PK ?? "").replace("TOPIC#", "");
    if (!parentTopicId || !knownTopicIds.has(parentTopicId)) continue;

    const facultyUid = it.faculty_uid;
    const rawCwid = typeof facultyUid === "string" ? stripCwidPrefix(facultyUid) : "";
    if (!rawCwid || !ourCwidSet.has(rawCwid)) continue;
    passedTopicScholar += 1;

    const rawPmid = it.pmid;
    const pmidStr =
      typeof rawPmid === "number" && Number.isFinite(rawPmid)
        ? String(rawPmid)
        : typeof rawPmid === "string" && /^\d+$/.test(rawPmid.trim())
          ? rawPmid.trim()
          : "";
    const score = typeof it.score === "number" ? it.score : NaN;
    const yearNum = typeof it.year === "number" ? it.year : NaN;
    const authorPosition = typeof it.author_position === "string" ? it.author_position : "";

    const badPmid = !pmidStr;
    const badScore = !Number.isFinite(score);
    const badYear = !Number.isFinite(yearNum);
    const badAuthorPosition = !authorPosition;

    if (badPmid || badScore || badYear || badAuthorPosition) {
      skippedMissingFields += 1;
      if (badPmid) missingPmid += 1;
      if (badScore) missingScore += 1;
      if (badYear) missingYear += 1;
      if (badAuthorPosition) missingAuthorPosition += 1;
      const n = [badPmid, badScore, badYear, badAuthorPosition].filter(Boolean).length;
      missingCountHist.set(n, (missingCountHist.get(n) ?? 0) + 1);
      if (samples.length < 6) {
        samples.push({
          PK: it.PK,
          pmid: rawPmid,
          pmid_type: typeof rawPmid,
          score: it.score,
          score_type: typeof it.score,
          year: it.year,
          year_type: typeof it.year,
          author_position: it.author_position,
          author_position_type: typeof it.author_position,
          all_keys: Object.keys(it).sort(),
        });
      }
    } else {
      validRows += 1;
    }
  }

  console.log(`Rows passing topic + scholar checks:  ${passedTopicScholar}`);
  console.log(`  skippedMissingFields:               ${skippedMissingFields}`);
  console.log(`  valid (reached publication check):  ${validRows}\n`);
  console.log(
    `Per-field absence among the ${skippedMissingFields} skipped rows (a row may lack more than one):`,
  );
  console.log(`  no valid pmid:        ${missingPmid}`);
  console.log(`  no finite score:      ${missingScore}`);
  console.log(`  no finite year:       ${missingYear}`);
  console.log(`  no author_position:   ${missingAuthorPosition}\n`);
  console.log(`Count of missing fields per skipped row:`);
  for (const [n, c] of [...missingCountHist.entries()].sort()) {
    console.log(`  missing ${n} field(s): ${c}`);
  }
  console.log(`\nSample skipped records:`);
  for (const s of samples) console.log(JSON.stringify(s, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
