/**
 * Probe script: connect to ReciterDB and print the column layout of the tables
 * we plan to query. Run this once before writing the real ETL so we know the
 * actual schema rather than guessing.
 *
 * Usage: `npm run etl:reciter:probe`
 */
import { closeReciterPool, withReciterConnection } from "@/lib/sources/reciterdb";

const TABLES_TO_INSPECT = [
  "analysis_summary_person",
  "analysis_summary_author",
  "analysis_summary_article",
  "identity",
  "publication_report",
  // Legacy VIVO tables — fall-through if analysis_summary_* aren't there.
  "wcmc_document",
  "wcmc_authorship",
  "wcmc_document_authorship",
];

async function main() {
  await withReciterConnection(async (conn) => {
    for (const table of TABLES_TO_INSPECT) {
      console.log(`\n=== ${table} ===`);
      try {
        const cols = (await conn.query(`DESCRIBE ${table}`)) as Array<{
          Field: string;
          Type: string;
          Null: string;
          Key: string;
          Default: string | null;
        }>;
        for (const c of cols) {
          console.log(`  ${c.Field.padEnd(40)} ${c.Type.padEnd(28)} ${c.Null}${c.Key ? " [" + c.Key + "]" : ""}`);
        }
        const countRows = (await conn.query(`SELECT COUNT(*) AS n FROM ${table}`)) as Array<{ n: number }>;
        console.log(`  -- ${countRows[0]?.n ?? "?"} rows`);
      } catch (e) {
        console.log(`  (table not found or unreadable: ${(e as Error).message.split("\n")[0]})`);
      }
    }

    // Sample a few personIdentifier values so we can confirm the prefix shape.
    console.log("\n=== sample personIdentifier values ===");
    const sampleAuthor = (await conn.query(
      "SELECT DISTINCT personIdentifier FROM analysis_summary_author ORDER BY id LIMIT 5",
    )) as Array<{ personIdentifier: string }>;
    for (const r of sampleAuthor) console.log(`  ${r.personIdentifier}`);

    console.log("\n=== sample identity.cwid values ===");
    const sampleIdentity = (await conn.query(
      "SELECT DISTINCT cwid FROM identity ORDER BY id LIMIT 5",
    )) as Array<{ cwid: string }>;
    for (const r of sampleIdentity) console.log(`  ${r.cwid}`);

    // Test: does IN (?) with array binding actually work for one known value?
    console.log("\n=== IN (?) array-binding sanity test ===");
    if (sampleAuthor.length > 0) {
      const knownIds = sampleAuthor.map((r) => r.personIdentifier);
      const test1 = (await conn.query(
        "SELECT COUNT(*) AS n FROM analysis_summary_author WHERE personIdentifier IN (?)",
        [knownIds],
      )) as Array<{ n: number }>;
      console.log(`  IN (?) with ${knownIds.length}-array param: ${test1[0]?.n ?? "?"} rows`);

      const test2 = (await conn.query(
        "SELECT COUNT(*) AS n FROM analysis_summary_author WHERE personIdentifier = ?",
        [knownIds[0]],
      )) as Array<{ n: number }>;
      console.log(`  = ? with single string  : ${test2[0]?.n ?? "?"} rows for "${knownIds[0]}"`);
    }
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await closeReciterPool();
  });
