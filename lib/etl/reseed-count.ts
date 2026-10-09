/**
 * #1987 — post-reseed row-count assertion for the loaders that rebuild a table
 * (or a partition of one) from a checked-in curated CSV.
 *
 * `mesh_curated_alias` sat ~8 weeks stale in prod: 10 rows against 74 in
 * etl/mesh-aliases/curated.csv. Freshness could not see it — it grades the
 * recency of the last SUCCESS row and never reads row counts, so a reseed that
 * "succeeds" with the wrong number of rows is invisible. These loaders know
 * exactly how many rows the table must hold once they are done, so they check,
 * inside the reseed transaction: a mismatch throws, the transaction rolls back
 * (the table keeps its prior contents), and the run records status='failed' with
 * a non-zero exit, which the Step Functions Catch and the freshness entry both
 * see.
 *
 * Pure (no `@/lib/db` edge), so the comparison is unit-testable; each loader
 * does its own `count()` and passes both numbers in.
 */

export interface ReseedCount {
  /** etl_run source / log prefix, e.g. "MeshAlias". */
  readonly source: string;
  /** What was counted, e.g. "mesh_curated_alias" or "family_sensitivity_overlay (source='seed')". */
  readonly table: string;
  /**
   * Rows the table must hold after the reseed — the POST-dedup/filter count the
   * loader actually wrote (e.g. CSV keys minus steward-owned ones), never the
   * raw line count when the loader skips or merges rows.
   */
  readonly expected: number;
  /** Rows the table actually holds, counted after the writes. */
  readonly actual: number;
  /** Where `expected` came from, for the message, e.g. "etl/mesh-aliases/curated.csv". */
  readonly from: string;
}

/** The failure message for a mismatch, or null when the counts agree. */
export function reseedCountMismatch(c: ReseedCount): string | null {
  if (c.actual === c.expected) return null;
  const delta = c.actual - c.expected;
  return (
    `[${c.source}] post-reseed row count mismatch: ${c.table} holds ${c.actual} row(s) but ` +
    `${c.expected} were loaded from ${c.from} (${delta > 0 ? "+" : ""}${delta}) — ` +
    `refusing to commit a reseed that does not match its source (#1987)`
  );
}

/** Throw on a mismatch. Call it INSIDE the reseed transaction so the throw rolls it back. */
export function assertReseedCount(c: ReseedCount): void {
  const message = reseedCountMismatch(c);
  if (message !== null) throw new Error(message);
}
