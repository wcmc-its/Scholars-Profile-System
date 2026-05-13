/**
 * db:check — print which MySQL/MariaDB the app is actually talking to.
 *
 * Background: local dev historically had two databases competing for port 3306
 * (host MariaDB and a now-removed `scholars-mysql` Docker container). Running
 * audits against the wrong one silently produced plausible-but-stale numbers.
 * This script makes the connection target obvious before any query work.
 *
 * Reports:
 *   - DATABASE_URL host:port and database
 *   - Server version + product (MySQL vs MariaDB)
 *   - Column count for `grant` (a quick #78-schema sanity check: pre-#78 = 10
 *     columns, post-#78 = 23+)
 *
 * Usage: npm run db:check
 */
import "dotenv/config";
import { createConnection } from "mariadb";

type VersionRow = { version: string };
type CountRow = { c: number };

function parseUrl(url: string): { host: string; port: number; database: string; user: string } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL not set. Copy .env.example to .env.local and set it.");
    process.exit(1);
  }

  const parsed = parseUrl(url);
  console.log("DATABASE_URL target:");
  console.log(`  host     ${parsed.host}`);
  console.log(`  port     ${parsed.port}`);
  console.log(`  database ${parsed.database}`);
  console.log(`  user     ${parsed.user}`);
  console.log();

  const conn = await createConnection({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    password: new URL(url).password ? decodeURIComponent(new URL(url).password) : undefined,
    bigIntAsNumber: true,
  });

  try {
    const [versionRow] = (await conn.query("SELECT VERSION() AS version")) as VersionRow[];
    const product = /mariadb/i.test(versionRow.version) ? "MariaDB" : "MySQL";
    console.log(`Server:    ${product} ${versionRow.version}`);

    const [grantCols] = (await conn.query(
      "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = ? AND table_name = ?",
      [parsed.database, "grant"],
    )) as CountRow[];
    console.log(`grant cols ${grantCols.c}  (pre-#78 = 10, post-#78 = 23+)`);

    if (grantCols.c === 0) {
      console.log();
      console.log("⚠  `grant` table not found in this database. Either you're pointing at the");
      console.log("    wrong DB, or migrations haven't been applied. Run: npm run db:migrate");
    } else if (grantCols.c < 20) {
      console.log();
      console.log("⚠  `grant` column count looks pre-#78. Migrations may be behind.");
      console.log("    Run: npm run db:migrate");
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
