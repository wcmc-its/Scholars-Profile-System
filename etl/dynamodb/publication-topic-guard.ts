/**
 * Regression guard for `etl/dynamodb/index.ts` Block 2 (issue #91).
 *
 * Issue #91: subtopic pages rendered empty — no publications and no
 * researchers — because the TOPIC# -> publication_topic projection had
 * never landed its rows. The ETL reported `success` anyway: Block 2 had
 * no post-write check, so an empty join table reached production
 * silently. Both the subtopic publication feed and the subtopic-scholars
 * row (#93, which keys on publication_topic.primarySubtopicId) read this
 * one table, so an empty publication_topic blanks every subtopic page.
 *
 * This is the post-Block-2 gate. It *throws* rather than warns: a bad
 * run then marks its `etl_run` row `failed`, exits non-zero, and shows
 * as FAIL in the daily orchestrator summary (etl/orchestrate.ts) — not a
 * ✓ that hides the regression. Block 1's topic-count check only
 * `console.warn`s, which is fine for a soft off-by-N anomaly but too
 * quiet for a join table whose emptiness breaks pages outright.
 *
 * Kept pure (no Prisma, no I/O) so the threshold logic is unit-testable
 * without a DynamoDB scan — the same split as `./top-topic-resolver.ts`.
 */

export type PublicationTopicGuardInput = {
  /** Total rows in `publication_topic` after the Block 2 upsert loop. */
  tableCount: number;
  /** TOPIC# records the DynamoDB scan returned this run. */
  scannedCount: number;
  /** Rows that cleared the FK/field guards and were upserted this run. */
  upsertedCount: number;
};

/**
 * Throws when `publication_topic` is in a state that would render
 * subtopic pages empty. Two failure modes, both the #91 regression:
 *
 *   1. The table is empty outright — no run has ever populated it (or
 *      this run produced nothing and the table was already empty). This
 *      is the literal #91 root cause.
 *   2. The TOPIC# scan returned records but none were upserted — every
 *      row was rejected by an FK/field guard. publication_topic may
 *      still hold stale rows from a prior run, but a scan that lands
 *      zero rows means the projection is structurally broken (empty
 *      scholar set, empty topic catalog, or no matching publications).
 *
 * A scan that returns zero records against a non-empty table is NOT a
 * failure — that is a quiet upstream day with nothing to upsert. No-op.
 *
 * Mode 1 is checked first, so an empty table always reports as such even
 * when mode 2's condition also holds.
 */
export function assertPublicationTopicPopulated(
  input: PublicationTopicGuardInput,
): void {
  const { tableCount, scannedCount, upsertedCount } = input;

  if (tableCount === 0) {
    throw new Error(
      "publication_topic is empty after the TOPIC# block — every subtopic " +
        "page would render no publications and no researchers. Confirm the " +
        "upstream ReCiterAI TOPIC# records exist, then re-run " +
        "`npm run etl:dynamodb`. (issue #91)",
    );
  }

  if (scannedCount > 0 && upsertedCount === 0) {
    throw new Error(
      `the TOPIC# scan returned ${scannedCount} record(s) but none were ` +
        "upserted into publication_topic — every row was rejected by an " +
        "FK/field guard (missing scholar, parent topic, publication, or a " +
        "required field). The table still holds prior-run rows, but this " +
        "run landed nothing and the projection is broken. (issue #91)",
    );
  }
}
