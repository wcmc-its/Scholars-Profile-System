import "dotenv/config";
import { withReciterConnection, closeReciterPool } from "@/lib/sources/reciterdb";

async function main() {
  await withReciterConnection(async (conn) => {
    const cols = (await conn.query("DESCRIBE analysis_summary_article")) as Array<{
      Field: string;
      Type: string;
    }>;
    for (const c of cols) console.log(`  ${c.Field.padEnd(40)} ${c.Type}`);
  });
  await closeReciterPool();
}
main().catch(async (e) => {
  console.error(e);
  await closeReciterPool();
  process.exit(1);
});
