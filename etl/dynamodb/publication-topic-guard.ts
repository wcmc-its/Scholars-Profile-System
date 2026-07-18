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
 * Throws when `publication_topic` did not end this run in a state that can
 * render subtopic pages. Two failure modes, both the #91 regression:
 *
 *   1. The table is empty outright — no run has ever populated it (or this
 *      run produced nothing and the table was already empty). The literal
 *      #91 root cause.
 *   2. Zero rows were upserted this run. Block 2 feeds off a single
 *      *unfiltered full-table* DynamoDB scan (etl/dynamodb/index.ts), not a
 *      delta — so a healthy run always scans ~78k TOPIC# records and lands
 *      rows. `upsertedCount === 0` means either the scan came back empty
 *      (the TOPIC# rows vanished, or the DynamoDB TABLE env points at the
 *      wrong table) or every scanned row was rejected by an FK/field guard
 *      (the projection is broken). publication_topic may still hold
 *      prior-run rows and pages may still render — but a run that lands
 *      nothing against a full scan is a silent-staleness trap, not a quiet
 *      day. The old `scannedCount === 0` carve-out let a 100%-gone source
 *      pass as success; there is no quiet-day case for a full scan.
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

  if (upsertedCount === 0) {
    const cause =
      scannedCount === 0
        ? "the full-table scan returned zero TOPIC# records — the source " +
          "rows have vanished or the DynamoDB TABLE env points at the wrong " +
          "table"
        : `the scan returned ${scannedCount} TOPIC# record(s) but every one ` +
          "was rejected by an FK/field guard (missing scholar, parent topic, " +
          "publication, or a required field) — the projection is broken";
    throw new Error(
      `no publication_topic rows were upserted this run: ${cause}. The table ` +
        "still holds prior-run rows, but this run landed nothing, so subtopic " +
        "pages would silently freeze on stale data. Confirm the upstream " +
        "ReCiterAI TOPIC# records and the DynamoDB TABLE env, then re-run " +
        "`npm run etl:dynamodb`. (issue #91)",
    );
  }
}
