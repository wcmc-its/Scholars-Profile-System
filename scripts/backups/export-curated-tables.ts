/**
 * export-curated-tables.ts — logical backup of the hand-curated,
 * staging-authoritative tables to a gzipped SQL file (+ S3).
 *
 * Why this exists
 * ---------------
 * Staging is the system-of-record for data that humans curate by hand through
 * `/edit` — org-unit structure/names/leaders/descriptions and the
 * methods-&-tools family-visibility overlays — including edits made by external
 * Comms collaborators. AWS Backup (daily snapshot, 14-day retention,
 * cross-region copy) + Aurora PITR (14-day window) already protect the whole
 * cluster, but those are *whole-cluster* restores into a new cluster, not a
 * row-level "undo his edits" and not durable beyond 14 days. This script is the
 * belt-and-suspenders the runbook calls for: a small, diffable, restorable,
 * long-lived logical export of just the curated tables.
 *
 * It is a `mysqldump`-equivalent produced entirely in-process via Prisma raw
 * queries (`SHOW CREATE TABLE` for DDL + `SELECT` for rows). We do NOT shell out
 * to `mysqldump`/`mariadb-dump` because the `sps-etl-<env>` task image is
 * Node-only and the dump binary is not guaranteed to be installed. The emitted
 * file is plain SQL: replay it into a SCRATCH schema with the `mariadb` client
 * (which the task image *does* have) to recover.
 *
 * What it captures
 * ----------------
 * See {@link CURATED_TABLES}. Org-unit tables + the two family-visibility
 * overlay tables + the cross-cutting manual-curation tables (`field_override`,
 * `suppression`) where org-unit descriptions / leader overrides / overviews are
 * actually stored. ETL-regenerable tables (scholar_tool, scholar_family,
 * spotlight, topics, the search index) are deliberately excluded — they are
 * rebuilt from upstream sources, not hand-entered.
 *
 * Usage
 * -----
 *   # In-VPC, against staging (the normal path — run as an ECS run-task on
 *   # sps-etl-staging; DATABASE_URL + CURATION_BACKUP_BUCKET are baked in):
 *   npm run backup:curated
 *
 *   # Local validation against the dev DB, write a file instead of uploading:
 *   DATABASE_URL=mysql://… npm run backup:curated -- --out /tmp --allow-missing
 *
 *   # See exactly what would be produced without writing anything:
 *   npm run backup:curated -- --dry-run
 *
 * Flags
 * -----
 *   --out <dir>       Write `<dir>/curated-tables-<stamp>.sql.gz` (+ manifest)
 *                     locally instead of uploading to S3.
 *   --dry-run         Build everything, print the manifest, write nothing.
 *   --allow-missing   Skip configured tables absent from the DB (default: ERROR
 *                     — a real table missing on staging must fail loudly).
 *   --no-drop         Omit `DROP TABLE IF EXISTS` before each `CREATE TABLE`.
 *   --env <name>      Override the env label in the S3 key / manifest. Defaults
 *                     to CURATION_BACKUP_ENV, else inferred from the DB host.
 *
 * Env
 * ---
 *   DATABASE_URL              (required) — the cluster to dump.
 *   CURATION_BACKUP_BUCKET    S3 bucket for uploads (injected by EtlStack).
 *   CURATION_BACKUP_PREFIX    key prefix (default "sps-curation-backups").
 *   CURATION_BACKUP_ENV       env label override.
 *   AWS_REGION / AWS_DEFAULT_REGION   (default "us-east-1").
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "../../lib/db";

// ---------------------------------------------------------------------------
// The curated set. Grouped for readability; order matters only for restore
// readability (FK checks are disabled in the dump header, so any order loads).
// To add/remove a table, edit this one list.
// ---------------------------------------------------------------------------
const CURATED_TABLES: readonly string[] = [
  // --- Org units: structure, names, membership, admins ---
  "department",
  "division",
  "center",
  "center_program",
  // NB: there is no `center_membership_type` TABLE — `CenterMembershipType`
  // (research/clinical) is a Prisma ENUM realized as the `membership_type`
  // column on `center_membership`, so that data is already captured below.
  "center_membership",
  "division_membership",
  "unit_admin",
  // --- Methods & tools: family-visibility overlays (DB is the SOR) ---
  "family_suppression_overlay",
  "family_sensitivity_overlay",
  // --- Cross-cutting manual curation. Org-unit descriptions, leader
  //     overrides, "overview for others", and hand suppress/show decisions
  //     are stored here, so these are part of the org-unit curation surface. ---
  "field_override",
  "suppression",
];

interface ColumnMeta {
  name: string;
  dataType: string;
  generated: boolean;
}

interface TableDump {
  table: string;
  rows: number;
  columns: number;
  sql: string;
}

interface CliOptions {
  out: string | null;
  dryRun: boolean;
  allowMissing: boolean;
  drop: boolean;
  envOverride: string | null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    out: null,
    dryRun: false,
    allowMissing: false,
    drop: true,
    envOverride: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i] ?? ".";
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--allow-missing") opts.allowMissing = true;
    else if (a === "--no-drop") opts.drop = false;
    else if (a === "--env") opts.envOverride = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

/** UTC `YYYY-MM-DD HH:MM:SS[.fff]` — the header pins time_zone to +00:00. */
function toMysqlDateTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const base =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${p(ms, 3)}` : base;
}

function toMysqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

const ESCAPE_MAP: Record<string, string> = {
  "\0": "\\0",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
  "\x1a": "\\Z",
  '"': '\\"',
  "'": "\\'",
  "\\": "\\\\",
};

function escapeString(s: string): string {
  return `'${s.replace(/[\0\b\t\n\r\x1a"'\\]/g, (c) => ESCAPE_MAP[c])}'`;
}

const NUMERIC_TYPES = new Set([
  "decimal",
  "numeric",
  "float",
  "double",
  "int",
  "integer",
  "bigint",
  "smallint",
  "mediumint",
  "tinyint",
  "year",
]);

/** Render one column value as a SQL literal, faithful to its column type. */
function formatValue(v: unknown, dataType: string): string {
  if (v === null || v === undefined) return "NULL";
  const t = dataType.toLowerCase();
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Date) {
    return t === "date" ? `'${toMysqlDate(v)}'` : `'${toMysqlDateTime(v)}'`;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const buf = Buffer.from(v as Uint8Array);
    return buf.length ? `0x${buf.toString("hex")}` : "''";
  }
  if (typeof v === "object") {
    // JSON columns come back as parsed objects/arrays from the driver.
    return escapeString(JSON.stringify(v));
  }
  const s = String(v);
  // DECIMAL/BIGINT are returned as strings to preserve precision — emit them
  // unquoted when the column is numeric and the value is a clean number.
  if (NUMERIC_TYPES.has(t) && /^-?\d+(\.\d+)?$/.test(s)) return s;
  return escapeString(s);
}

async function tableExists(database: string, table: string): Promise<boolean> {
  const rows = await db.read.$queryRawUnsafe<{ n: bigint }[]>(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    database,
    table,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function getColumns(
  database: string,
  table: string,
): Promise<ColumnMeta[]> {
  const rows = await db.read.$queryRawUnsafe<
    { COLUMN_NAME: string; DATA_TYPE: string; EXTRA: string }[]
  >(
    "SELECT COLUMN_NAME, DATA_TYPE, EXTRA FROM information_schema.COLUMNS " +
      "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
    database,
    table,
  );
  return rows.map((r) => ({
    name: r.COLUMN_NAME,
    dataType: r.DATA_TYPE,
    // Generated/virtual columns cannot be inserted into — exclude them.
    generated: /GENERATED/i.test(r.EXTRA ?? ""),
  }));
}

const ROWS_PER_INSERT = 200;

async function dumpTable(
  database: string,
  table: string,
  drop: boolean,
): Promise<TableDump> {
  const columns = (await getColumns(database, table)).filter(
    (c) => !c.generated,
  );
  if (columns.length === 0) {
    throw new Error(`Table ${table} has no insertable columns.`);
  }
  const colIdent = columns.map((c) => `\`${c.name}\``);

  // DDL straight from the server so the restore recreates the table exactly.
  const ddlRows = await db.read.$queryRawUnsafe<
    Record<string, string>[]
  >(`SHOW CREATE TABLE \`${table}\``);
  const createStmt = ddlRows[0]?.["Create Table"];
  if (!createStmt) {
    throw new Error(`SHOW CREATE TABLE returned no DDL for ${table}.`);
  }

  // Row data, columns explicitly named (stable order; generated cols excluded).
  const dataRows = await db.read.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${colIdent.join(", ")} FROM \`${table}\``,
  );

  const parts: string[] = [];
  parts.push(`-- ---------- ${table} (${dataRows.length} rows) ----------`);
  if (drop) parts.push(`DROP TABLE IF EXISTS \`${table}\`;`);
  parts.push(`${createStmt};`);

  for (let i = 0; i < dataRows.length; i += ROWS_PER_INSERT) {
    const chunk = dataRows.slice(i, i + ROWS_PER_INSERT);
    const valueTuples = chunk.map((row) => {
      const vals = columns.map((c) => formatValue(row[c.name], c.dataType));
      return `(${vals.join(",")})`;
    });
    parts.push(
      `INSERT INTO \`${table}\` (${colIdent.join(", ")}) VALUES\n` +
        valueTuples.join(",\n") +
        ";",
    );
  }
  parts.push("");

  return {
    table,
    rows: dataRows.length,
    columns: columns.length,
    sql: parts.join("\n"),
  };
}

/** Best-effort env label from the DB host when not explicitly provided. */
function inferEnv(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (/staging/i.test(url)) return "staging";
  if (/prod/i.test(url)) return "prod";
  return "local";
}

function buildKeys(prefix: string, env: string, generatedAt: Date) {
  const stamp = generatedAt.toISOString().replace(/[:]/g, "").replace(/\..+/, "Z");
  const day = generatedAt.toISOString().slice(0, 10);
  const base = `${prefix}/${env}`;
  return {
    sql: `${base}/${day}/curated-tables-${stamp}.sql.gz`,
    manifest: `${base}/${day}/curated-tables-${stamp}.manifest.json`,
    latestSql: `${base}/latest/curated-tables.sql.gz`,
    latestManifest: `${base}/latest/curated-tables.manifest.json`,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — nothing to back up.");
  }

  const env = opts.envOverride ?? process.env.CURATION_BACKUP_ENV ?? inferEnv();
  const generatedAt = new Date();

  const dbRow = await db.read.$queryRawUnsafe<{ db: string }[]>(
    "SELECT DATABASE() AS db",
  );
  const database = dbRow[0]?.db;
  if (!database) throw new Error("Could not resolve current database name.");

  // Resolve which configured tables are actually present. A real table missing
  // on staging must fail loudly (a partial backup labelled complete is a trap),
  // unless --allow-missing is passed for local/dev where some migrations lag.
  const present: string[] = [];
  const missing: string[] = [];
  for (const t of CURATED_TABLES) {
    if (await tableExists(database, t)) present.push(t);
    else missing.push(t);
  }
  if (missing.length > 0 && !opts.allowMissing) {
    throw new Error(
      `Configured tables missing from ${database}: ${missing.join(", ")}. ` +
        `Pass --allow-missing to dump only the present tables (dev only).`,
    );
  }
  if (missing.length > 0) {
    console.warn(`⚠️  Skipping missing tables: ${missing.join(", ")}`);
  }

  const dumps: TableDump[] = [];
  for (const t of present) {
    process.stdout.write(`  dumping ${t} … `);
    const d = await dumpTable(database, t, opts.drop);
    console.log(`${d.rows} rows`);
    dumps.push(d);
  }

  const header = [
    "-- SPS curated-tables logical backup (mysqldump-compatible).",
    `-- env: ${env}   database: ${database}`,
    `-- generated: ${generatedAt.toISOString()}   tables: ${dumps.length}`,
    "-- RESTORE INTO A SCRATCH SCHEMA, NOT PRODUCTION.",
    "-- See docs/curation-backup-runbook.md for the restore procedure.",
    "SET NAMES utf8mb4;",
    "SET time_zone = '+00:00';",
    "SET FOREIGN_KEY_CHECKS = 0;",
    "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
    "",
    "",
  ].join("\n");
  const footer = "\nSET FOREIGN_KEY_CHECKS = 1;\n";
  const sqlText = header + dumps.map((d) => d.sql).join("\n") + footer;

  const sqlGz = gzipSync(Buffer.from(sqlText, "utf8"), { level: 9 });
  const totalRows = dumps.reduce((n, d) => n + d.rows, 0);
  const manifest = {
    tool: "export-curated-tables",
    env,
    database,
    generatedAt: generatedAt.toISOString(),
    tables: dumps.map((d) => ({ table: d.table, rows: d.rows, columns: d.columns })),
    totalRows,
    sqlBytes: Buffer.byteLength(sqlText, "utf8"),
    gzBytes: sqlGz.byteLength,
    sha256Gz: createHash("sha256").update(sqlGz).digest("hex"),
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `\n${dumps.length} tables, ${totalRows} rows, ` +
      `${(sqlGz.byteLength / 1024).toFixed(1)} KiB gzipped.`,
  );

  if (opts.dryRun) {
    console.log("\n--dry-run: nothing written.\n");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (opts.out) {
    const dir = path.resolve(opts.out);
    await mkdir(dir, { recursive: true });
    const stamp = generatedAt
      .toISOString()
      .replace(/[:]/g, "")
      .replace(/\..+/, "Z");
    const sqlPath = path.join(dir, `curated-tables-${stamp}.sql.gz`);
    const manifestPath = path.join(dir, `curated-tables-${stamp}.manifest.json`);
    await writeFile(sqlPath, sqlGz);
    await writeFile(manifestPath, manifestBuf);
    console.log(`Wrote ${sqlPath}`);
    console.log(`Wrote ${manifestPath}`);
    return;
  }

  const bucket = process.env.CURATION_BACKUP_BUCKET;
  if (!bucket) {
    throw new Error(
      "CURATION_BACKUP_BUCKET is not set. Set it, or pass --out <dir> to write " +
        "locally. (EtlStack injects it on the deployed sps-etl-<env> task.)",
    );
  }
  const prefix = process.env.CURATION_BACKUP_PREFIX ?? "sps-curation-backups";
  const region =
    process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const keys = buildKeys(prefix, env, generatedAt);
  const s3 = new S3Client({ region });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.sql,
      Body: sqlGz,
      ContentType: "application/gzip",
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.manifest,
      Body: manifestBuf,
      ContentType: "application/json",
    }),
  );
  // Stable "newest" pointer so a restore can fetch without listing.
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.latestSql,
      Body: sqlGz,
      ContentType: "application/gzip",
    }),
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: keys.latestManifest,
      Body: manifestBuf,
      ContentType: "application/json",
    }),
  );

  console.log(`\nUploaded to s3://${bucket}/${keys.sql}`);
  console.log(`Latest pointer: s3://${bucket}/${keys.latestSql}`);
}

main()
  .then(async () => {
    await db.read.$disconnect();
    await db.write.$disconnect();
  })
  .catch(async (err) => {
    console.error(`\nBackup FAILED: ${err instanceof Error ? err.message : err}`);
    await db.read.$disconnect().catch(() => {});
    await db.write.$disconnect().catch(() => {});
    process.exitCode = 1;
  });
