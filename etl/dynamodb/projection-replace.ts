/**
 * guardedReplace — atomic, sanity-guarded full-table rebuild for the
 * `etl/dynamodb` projection blocks (nightly projection-wipe hardening).
 *
 * Both full-rebuild blocks in ./index.ts (topic_assignment, scholar_tool) used
 * to `deleteMany()` then chunked-`createMany()` with no transaction and no
 * floor. A bad upstream DynamoDB scan (empty or partial result) would wipe the
 * live table and replace it with far fewer — or zero — rows, and a mid-run
 * failure left the table half-loaded. The post-write `=== 0` guards only catch
 * a fully-empty result, not a partial one (e.g. live 70k, incoming 3k).
 *
 * This helper mirrors etl/mentoring/import-aoc.ts:
 *
 *   1. SANITY GUARD (relative + floor, NOT `=== 0`): if the table is currently
 *      populated and the incoming row set is implausibly small vs. it, throw
 *      BEFORE any delete. The throw names the table, the incoming count, and
 *      the live count.
 *   2. ATOMICITY: deleteMany() + the chunked createMany loop run inside ONE
 *      interactive `$transaction`, so a mid-run failure rolls back to the prior
 *      contents (no half-loaded window; readers see the old rows until commit,
 *      then the new ones).
 *
 * Kept in a sibling module — like ./publication-topic-guard.ts and the mapper
 * modules — so it can be unit-tested with a mocked Prisma client without
 * importing index.ts (whose top-level `main()` would run the whole ETL).
 */
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "../../lib/db";

// ponytail: MAX_SHRINK_FRACTION / MIN_FLOOR are deliberately loose starting
// values — tune them down once we have observed run-to-run variance for each
// table (a real nightly only adds/drops a few %). Centralized here, not
// per-call, until that variance says otherwise.
export const MAX_SHRINK_FRACTION = 0.5; // tolerate up to a 50% drop vs. the live count
export const MIN_FLOOR = 50; // ...but never accept fewer than this when live > 0

/** A Prisma model delegate, narrowed to the calls guardedReplace makes. */
export type ReplaceDelegate<TData> = {
  count: () => Promise<number>;
  deleteMany: () => Promise<{ count: number }>;
  createMany: (args: {
    data: TData[];
    skipDuplicates?: boolean;
  }) => Promise<{ count: number }>;
};

/**
 * Compute the minimum acceptable incoming row count for a populated table.
 * Pure so the threshold is unit-testable without a DB. `live === 0` yields a
 * floor of 0 (a first/empty load is always allowed).
 */
export function replaceFloor(live: number): number {
  if (live <= 0) return 0;
  return Math.max(MIN_FLOOR, Math.ceil(live * (1 - MAX_SHRINK_FRACTION)));
}

export type GuardedReplaceOptions<TRow, TData> = {
  table: string;
  rows: TRow[];
  batchSize: number;
  toData: (batch: TRow[]) => TData[];
  /**
   * Selects the SAME model delegate off the live client (for the count) and off
   * the transaction client (for the writes), e.g. `(c) => c.topicAssignment`.
   */
  pick: (client: typeof db.write | Prisma.TransactionClient) => ReplaceDelegate<TData>;
};

/**
 * Atomically replace a full table's contents with `rows`, refusing an
 * implausible shrink (see module header). Returns the number of rows inserted.
 */
export async function guardedReplace<TRow, TData>(
  opts: GuardedReplaceOptions<TRow, TData>,
): Promise<number> {
  const { table, rows, batchSize, toData, pick } = opts;

  const live = await pick(db.write).count();
  const floor = replaceFloor(live);
  if (live > 0 && rows.length < floor) {
    throw new Error(
      `${table} sanity guard: incoming ${rows.length} rows is below the floor ` +
        `${floor} (live ${live}, max-shrink ${MAX_SHRINK_FRACTION}, min-floor ${MIN_FLOOR}) — ` +
        "refusing to wipe a populated table from a likely partial/empty upstream " +
        "scan. Re-run after confirming the DynamoDB source.",
    );
  }

  let inserted = 0;
  await db.write.$transaction(
    async (tx) => {
      const model = pick(tx);
      const cleared = await model.deleteMany();
      console.log(`Cleared ${cleared.count} existing ${table} rows.`);
      for (let i = 0; i < rows.length; i += batchSize) {
        await model.createMany({
          data: toData(rows.slice(i, i + batchSize)),
          skipDuplicates: true,
        });
        inserted += Math.min(batchSize, rows.length - i);
      }
    },
    // Generous bounds: a full reload of a projection table is larger than a
    // single statement but still a one-off nightly task (mirror import-aoc).
    { timeout: 120_000, maxWait: 30_000 },
  );
  return inserted;
}
