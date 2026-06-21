import "dotenv/config";
import { withReciterConnection, closeReciterPool } from "@/lib/sources/reciterdb";

async function main() {
  await withReciterConnection(async (conn) => {
    const cols = (await conn.query("DESCRIBE analysis_nih")) as Array<{
      Field: string;
      Type: string;
    }>;
    console.log("=== analysis_nih columns ===");
    for (const c of cols) console.log(`  ${c.Field.padEnd(40)} ${c.Type}`);
    const sample = (await conn.query(
      "SELECT * FROM analysis_nih LIMIT 2",
    )) as Array<Record<string, unknown>>;
    console.log("=== sample rows ===");
    console.log(JSON.stringify(sample, null, 2));
  });
  await closeReciterPool();
}
main().catch(async (e) => {
  console.error("PROBE_ERROR:", e instanceof Error ? e.message : e);
  await closeReciterPool();
  process.exit(1);
});
