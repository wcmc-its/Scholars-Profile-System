/**
 * Probe script: scan every TOPIC# item in the ReCiterAI `reciterai` DynamoDB
 * table and report how many distinct publications ReciterAI has topic-processed
 * and how many carry a plain-language synopsis (issue #329).
 *
 * Synopsis is denormalized onto every TOPIC# row for a pmid (see
 * etl/dynamodb/index.ts Block 2c), so the probe also checks the coupling
 * invariant: every TOPIC# row should carry a synopsis. The headline number,
 * distinct topic-processed pmids, grows as ReciterAI processes more of the
 * corpus; it gates whether synopsis is dense enough to surface in publication
 * search snippets (vs. the detail modal only).
 *
 * Read-only: scans DynamoDB, writes nothing.
 *
 * Env: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION (or
 * AWS_REGION); SCHOLARS_DYNAMODB_TABLE (default: reciterai).
 *
 * Usage: `npm run etl:dynamodb:probe-synopsis`
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, type ScanCommandInput } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.SCHOLARS_DYNAMODB_TABLE ?? "reciterai";
const REGION = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function main() {
  const allPmids = new Set<string>();
  const synPmids = new Set<string>();
  let topicItems = 0;
  let synRows = 0;
  const lengths: number[] = [];
  const samples: Array<{ pmid: string; synopsis: string }> = [];

  let startKey: ScanCommandInput["ExclusiveStartKey"];
  let pages = 0;

  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: TABLE,
        FilterExpression: "begins_with(#pk, :t)",
        ProjectionExpression: "#pmid, #syn",
        ExpressionAttributeNames: { "#pk": "PK", "#pmid": "pmid", "#syn": "synopsis" },
        ExpressionAttributeValues: { ":t": "TOPIC#" },
        ExclusiveStartKey: startKey,
      }),
    );
    pages++;
    for (const it of res.Items ?? []) {
      topicItems++;
      const pmid = it.pmid != null ? String(it.pmid) : "";
      if (!pmid) continue;
      allPmids.add(pmid);
      const syn = typeof it.synopsis === "string" ? it.synopsis.trim() : "";
      if (syn) {
        synRows++;
        if (!synPmids.has(pmid)) {
          synPmids.add(pmid);
          lengths.push(syn.length);
          if (samples.length < 8) samples.push({ pmid, synopsis: syn });
        }
      }
    }
    startKey = res.LastEvaluatedKey;
    if (pages % 20 === 0) {
      process.stderr.write(`  ...${pages} pages, ${topicItems} TOPIC# items so far\n`);
    }
  } while (startKey && pages < 4000);

  const total = allPmids.size;
  const withSyn = synPmids.size;
  const couplingOk = synRows === topicItems && withSyn === total;
  const couplingMsg = couplingOk
    ? "OK - synopsis present on every TOPIC# row"
    : "VIOLATED - some TOPIC# rows have no synopsis";
  const pct = total ? ((100 * withSyn) / total).toFixed(1) : "0";

  console.log(`\n=== ReciterAI synopsis probe: DynamoDB ${TABLE} (${REGION}) ===`);
  console.log(`  ${"scan pages".padEnd(34)}${pages}`);
  console.log(`  ${"TOPIC# items scanned".padEnd(34)}${topicItems}`);
  console.log(`  ${"distinct topic-processed pmids".padEnd(34)}${total}   <- ReciterAI coverage`);
  console.log(`  ${"TOPIC# rows carrying synopsis".padEnd(34)}${synRows} / ${topicItems}`);
  console.log(`  ${"pmids carrying synopsis".padEnd(34)}${withSyn} / ${total}  (${pct}%)`);
  console.log(`  ${"synopsis-coupling invariant".padEnd(34)}${couplingMsg}`);

  if (lengths.length) {
    lengths.sort((a, b) => a - b);
    const sum = lengths.reduce((a, b) => a + b, 0);
    const min = lengths[0];
    const max = lengths[lengths.length - 1];
    const median = lengths[Math.floor(lengths.length / 2)];
    const avg = Math.round(sum / lengths.length);
    const stats = `min ${min} / median ${median} / avg ${avg} / max ${max}`;
    console.log(`  ${"synopsis length (chars)".padEnd(34)}${stats}`);
  }

  console.log("\n  --- sample synopses ---");
  for (const s of samples) {
    console.log(`  [${s.pmid}] (${s.synopsis.length} ch) ${s.synopsis}`);
  }
}

main().catch((err) => {
  console.error("PROBE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
