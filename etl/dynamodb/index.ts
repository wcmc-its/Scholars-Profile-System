/**
 * DynamoDB ETL — Phase 4f.
 *
 * Scans the FACULTY# partition of the ReciterAI chatbot table and projects
 * each scholar's top_topics into our topic_assignment table (Q6 minimal
 * projection). Empty/missing top_topics → no rows for that scholar.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or AWS_REGION)
 *   SCHOLARS_DYNAMODB_TABLE  (default: reciterai-chatbot)
 *
 * Usage: `npm run etl:dynamodb`
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { prisma } from "@/lib/db";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai-chatbot";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

type FacultyRecord = {
  PK: string; // FACULTY#cwid_<cwid>
  SK?: string;
  top_topics?: Array<{ topic_id?: string; topic?: string; score: number }> | unknown;
  [key: string]: unknown;
};

async function main() {
  const start = Date.now();
  const run = await prisma.etlRun.create({
    data: { source: "ReCiterAI-projection", status: "running" },
  });

  try {
    const ourScholars = await prisma.scholar.findMany({
      where: { deletedAt: null, status: "active" },
      select: { cwid: true },
    });
    const ourCwidSet = new Set(ourScholars.map((s) => s.cwid));
    console.log(`Active scholars: ${ourCwidSet.size}; scanning ${TABLE} for FACULTY# records...`);

    const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
    const items: FacultyRecord[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let scanned = 0;

    do {
      const resp = await ddb.send(
        new ScanCommand({
          TableName: TABLE,
          FilterExpression: "begins_with(PK, :prefix)",
          ExpressionAttributeValues: { ":prefix": "FACULTY#cwid_" },
          ExclusiveStartKey: lastKey,
        }),
      );
      for (const it of (resp.Items ?? []) as FacultyRecord[]) items.push(it);
      scanned += resp.ScannedCount ?? 0;
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);
    console.log(`Scanned ~${scanned} items, kept ${items.length} FACULTY# records.`);

    if (items.length > 0) {
      console.log("Sample record:", JSON.stringify(items[0], null, 2).slice(0, 500));
    }

    type TopicRow = { cwid: string; topic: string; score: number };
    const rows: TopicRow[] = [];
    for (const it of items) {
      const m = it.PK.match(/^FACULTY#cwid_(.+)$/);
      if (!m) continue;
      const cwid = m[1];
      if (!ourCwidSet.has(cwid)) continue;
      const tt = it.top_topics;
      if (!Array.isArray(tt)) continue;
      for (const t of tt as Array<Record<string, unknown>>) {
        const topic =
          (typeof t.topic === "string" && t.topic) ||
          (typeof t.topic_id === "string" && t.topic_id) ||
          null;
        const score =
          typeof t.score === "number"
            ? t.score
            : typeof t.max_score === "number"
              ? t.max_score
              : null;
        if (!topic || score === null) continue;
        rows.push({ cwid, topic, score });
      }
    }
    console.log(`Built ${rows.length} topic_assignment rows.`);

    console.log("Resetting topic_assignment table...");
    await prisma.topicAssignment.deleteMany();

    console.log(`Inserting ${rows.length}...`);
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      await prisma.topicAssignment.createMany({
        data: rows.slice(i, i + BATCH).map((r) => ({
          cwid: r.cwid,
          topic: r.topic,
          score: r.score,
          source: "ReCiterAI-DynamoDB",
        })),
        skipDuplicates: true,
      });
    }

    await prisma.etlRun.update({
      where: { id: run.id },
      data: { status: "success", completedAt: new Date(), rowsProcessed: rows.length },
    });

    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`DynamoDB ETL complete in ${elapsed}s: topic_assignments=${rows.length}`);
  } catch (err) {
    await prisma.etlRun.update({
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
    await prisma.$disconnect();
  });
