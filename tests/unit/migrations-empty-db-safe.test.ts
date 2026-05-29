/**
 * #584 — Prisma migrations must be safe to apply to an EMPTY database.
 *
 * CI's `build` job runs `prisma migrate deploy` against a fresh database, and the
 * same path is the #445 prod-bootstrap. A migration that seeds data (`INSERT INTO`)
 * into a table with a foreign key to a seed/ETL-owned parent (e.g. `center_program`
 * -> `center`) fails on a fresh DB with MySQL error 1452, because the parent rows
 * do not exist yet. That is exactly the bug #584 fixed: the center_management
 * migration seeded `center_program` against an empty `center` table.
 *
 * Rule: migrations are schema (DDL) + in-place backfills (UPDATE on existing rows)
 * only. Data seeds belong in a seed script (`prisma/seed-centers.ts`) or the ETL,
 * which run after their parent rows exist. This test is the fast-failing guard for
 * that rule; the canonical check is CI applying the migrations to a clean DB.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");

// Strip line comments (`-- ...`) and block comments so we only match real SQL.
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

function migrationSqlFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => statSync(path.join(MIGRATIONS_DIR, entry)).isDirectory())
    .map((dir) => {
      const file = path.join(MIGRATIONS_DIR, dir, "migration.sql");
      return { name: dir, sql: readFileSync(file, "utf8") };
    });
}

describe("#584 — migrations are safe on an empty database", () => {
  const files = migrationSqlFiles();

  it("finds migration files to check (guards against a broken glob)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no migration seeds data with INSERT — seeds belong in seed scripts / ETL", () => {
    const offenders = files
      .filter(({ sql }) => /\bINSERT\s+INTO\b/i.test(stripSqlComments(sql)))
      .map(({ name }) => name);

    expect(
      offenders,
      `These migrations contain a data INSERT, which fails on a fresh DB when the ` +
        `target table FKs to a seed/ETL-owned parent (MySQL 1452). Move the seed to ` +
        `a seed script or the ETL (run after parent rows exist): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the center_management migration is DDL-only (the #584 regression)", () => {
    const centerMgmt = files.find(({ name }) => name.endsWith("_center_management"));
    expect(centerMgmt, "center_management migration not found").toBeDefined();
    expect(/\bINSERT\s+INTO\b/i.test(stripSqlComments(centerMgmt!.sql))).toBe(false);
  });
});
