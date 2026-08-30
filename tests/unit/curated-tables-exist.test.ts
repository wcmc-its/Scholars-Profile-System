/**
 * `CURATED_TABLES` is a list of raw table-name STRINGS and, until this test,
 * nothing checked them against the schema. A rename that missed the list passed
 * typecheck, vitest and cdk, then the nightly `scholars-curation-backup-*` job
 * either hard-errored (`--allow-missing` defaults to ERROR) or shipped a dump
 * missing a hand-curated table. That is the whole failure mode: the curated
 * tables are the ones with no upstream to re-derive from, so a silently
 * incomplete dump is unrecoverable data loss.
 *
 * Found while re-keying the role vocabulary (#2542), which renamed two entries.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CURATED_TABLES } from "@/scripts/backups/export-curated-tables";

const schema = readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every physical table name the schema declares, via `@@map`. */
const mapped = new Set(Array.from(schema.matchAll(/@@map\("([^"]+)"\)/g), (m) => m[1]));

describe("CURATED_TABLES", () => {
  it("names only tables that exist in the schema", () => {
    const missing = CURATED_TABLES.filter((t) => !mapped.has(t));
    expect(
      missing,
      `These curated tables are not @@map'd by any model, so the backup job cannot dump them. ` +
        `A rename probably missed scripts/backups/export-curated-tables.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no table twice", () => {
    const dupes = CURATED_TABLES.filter((t, i) => CURATED_TABLES.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });
});
