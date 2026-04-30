/**
 * Wave 0 probe — read-only enumeration of DynamoDB partition prefixes
 * in the reciterai-chatbot table, plus sample records per prefix.
 *
 * Output: JSON to stdout. Pipe to .planning/phases/02-.../probe-output.json
 * for the D-02 schema decision in 02-SCHEMA-DECISION.md.
 *
 * No Prisma writes. No etl-run row creation. Read-only against DynamoDB.
 *
 * Env:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or AWS_REGION)
 *   SCHOLARS_DYNAMODB_TABLE  (default: reciterai-chatbot)
 *
 * Usage:
 *   npx tsx etl/dynamodb/probe.ts > .planning/phases/02-algorithmic-surfaces-and-home-composition/probe-output.json
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai-chatbot";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
const SAMPLE_LIMIT = 5;

type Sample = Record<string, unknown>;

async function main() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const prefixCounts = new Map<string, number>();
  const samples = new Map<string, Sample[]>();
  let totalScanned = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: TABLE,
        ExclusiveStartKey: lastKey,
        Limit: 1000,
      }),
    );
    for (const item of resp.Items ?? []) {
      totalScanned += 1;
      const pk = String(item.PK ?? "<missing-pk>");
      const prefix = pk.includes("#") ? pk.split("#")[0] + "#" : pk;
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
      const arr = samples.get(prefix) ?? [];
      if (arr.length < SAMPLE_LIMIT) arr.push(item as Sample);
      samples.set(prefix, arr);
    }
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  const output = {
    table: TABLE,
    region: REGION,
    capturedAt: new Date().toISOString(),
    totalScanned,
    prefixes: Object.fromEntries([...prefixCounts.entries()].sort()),
    samples: Object.fromEntries([...samples.entries()].sort()),
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
