/**
 * Read-only audit for issue #292: meshDescriptorUi smoke failure.
 * Drills into where "Humans" (D006801) is being lost.
 */
import "dotenv/config";
import { createConnection } from "mariadb";

function parseUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const cfg = parseUrl(url);
  const conn = await createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });

  console.log(`Connected to ${cfg.host}:${cfg.port}/${cfg.database}\n`);

  console.log("=== mesh_descriptor — does D006801 (Humans) exist? ===");
  const meshRow = await conn.query(
    `SELECT descriptor_ui, name FROM mesh_descriptor WHERE descriptor_ui = 'D006801' LIMIT 1`,
  );
  console.log(meshRow);

  console.log("\n=== publication.mesh_terms — how many rows contain ui='D006801'? ===");
  const pubD = await conn.query(`
    SELECT COUNT(*) AS n
    FROM publication
    WHERE JSON_CONTAINS(mesh_terms, JSON_OBJECT('ui', 'D006801'))
  `);
  console.log(pubD);

  console.log("\n=== publication.mesh_terms — rows containing label='Humans'? ===");
  const pubH = await conn.query(`
    SELECT COUNT(*) AS n
    FROM publication
    WHERE JSON_CONTAINS(mesh_terms, JSON_OBJECT('label', 'Humans'))
  `);
  console.log(pubH);

  console.log("\n=== Sample 3 rows that contain 'Humans' label, show their mesh_terms ===");
  const sample = await conn.query(`
    SELECT pmid, mesh_terms
    FROM publication
    WHERE JSON_CONTAINS(mesh_terms, JSON_OBJECT('label', 'Humans'))
    LIMIT 3
  `);
  for (const row of sample as Array<{ pmid: bigint | number; mesh_terms: unknown }>) {
    const arr = row.mesh_terms as Array<{ ui: string | null; label: string }>;
    const humansEntry = arr.find((m) => m.label === "Humans");
    console.log(`pmid=${row.pmid}: Humans entry =`, humansEntry, ` // total terms = ${arr.length}`);
  }

  console.log("\n=== mesh_descriptor — rows with name='Humans' ===");
  const meshHumans = await conn.query(
    `SELECT descriptor_ui, name FROM mesh_descriptor WHERE name = 'Humans'`,
  );
  console.log(meshHumans);

  await conn.end();

  // --- ReciterDB upstream check ---
  console.log("\n=== ReciterDB person_article_keyword — does it contain 'Humans'? ===");
  const rConn = await createConnection({
    host: process.env.SCHOLARS_RECITERDB_HOST,
    port: parseInt(process.env.SCHOLARS_RECITERDB_PORT ?? "3306", 10),
    user: process.env.SCHOLARS_RECITERDB_USERNAME,
    password: process.env.SCHOLARS_RECITERDB_PASSWORD,
    database: process.env.SCHOLARS_RECITERDB_DATABASE,
  });
  const rHumans = await rConn.query(
    `SELECT COUNT(*) AS n FROM person_article_keyword WHERE keyword = 'Humans'`,
  );
  console.log("rows with keyword='Humans':", rHumans);

  const rTop = await rConn.query(
    `SELECT keyword, COUNT(*) AS n FROM person_article_keyword GROUP BY keyword ORDER BY n DESC LIMIT 10`,
  );
  console.log("\nTop 10 keywords in ReciterDB:");
  console.log(rTop);

  await rConn.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
