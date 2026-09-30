/**
 * Pure helper for etl/dynamodb/index.ts Block 6b (CORE#/STAFF_DICT ->
 * core.staff_count + core.staff_tracked_count), split out so the per-record
 * parsing + guards can be unit-tested without a DynamoDB scan — the same split
 * as ./publication-core-mapper.ts.
 *
 * ReciterAI writes one item per core at `PK = CORE#{core_id}`,
 * `SK = STAFF_DICT`, carrying TWO counts drawn from the facility dictionary:
 *
 *   `staff_count`          how many CWIDs the dictionary LISTS under `staff:`
 *   `staff_tracked_count`  how many of those the co-author signal can MATCH
 *
 * The second is the load-bearing one, and it is NOT a formality. The signal
 * (pipeline_cores/signals.py `coauthorship_index`) reads the core's
 * `tracked_staff_cwids`, not its `staff:` list; a listed staff member with no
 * personIdentifier upstream is simply invisible to it. On the live dictionary
 * the two counts differ on 9 of 14 cores, and three of those list staff while
 * tracking none. A consumer given only the listed count would put "the
 * co-author signal draws on N core staff" on screen for cores where the signal
 * cannot fire at all — a chip asserting a mechanism that is not the one behind
 * the number, which is exactly the `decodeTopicalPrior` failure this codebase
 * has already shipped once. So both counts travel, together, all the way to
 * the UI.
 *
 * COUNTS ONLY, by contract — the consumer renders two integers, and copying
 * the staff CWIDs into a second datastore would be PII surface bought for
 * nothing. This mapper therefore reads exactly two attributes and there is
 * nothing here to mirror a roster with.
 *
 * Direction matters, and the SK suffix is how it is marked. `STAFF_DICT` is
 * dictionary-sourced and flows ReciterAI -> SPS. The bare `STAFF` key is
 * deliberately NOT used: it is reserved for a future SPS-curated staff list,
 * which by the existing `(CORE#{core_id}, CLIENTS)` precedent (SPS writes it
 * in lib/cores/client-writeback.ts, the engine reads it) would want exactly
 * that key and would run the other way. ./partition.ts keeps all three apart
 * on the exact `SK`.
 *
 * ABSENT IS NOT ZERO. A core with no STAFF_DICT item must produce NO write at
 * all, leaving both columns exactly as they were; a core whose item says
 * `staff_count: 0` must produce a write OF 0. That distinction is the whole
 * point of the nullable columns: NULL means "not published yet" (the queue
 * shows no chip), 0 means "the dictionary lists no staff for this core" (the
 * queue says the co-author signal cannot fire). Collapsing the two would be
 * this repo's standing failure mode — a fail-soft read on a path that WRITES
 * is a wipe — so the mapper only ever emits writes for items it actually saw,
 * and every skip is counted rather than defaulted.
 */

/**
 * Minimal shape of a CORE#/STAFF_DICT record consumed by the mapper. The
 * DocumentClient scan unmarshals the attribute format, so a DynamoDB `N`
 * arrives as a JS number; the string form is accepted too because a hand-
 * written item (or a `PutItem` from a script) can land it as `S`.
 */
export type CoreStaffRecordInput = {
  PK: string; // "CORE#{core_id}"
  SK: string; // "STAFF_DICT"
  core_id?: string;
  staff_count?: number | string;
  staff_tracked_count?: number | string;
};

export type CoreStaffWrite = {
  coreId: string;
  /** Listed in the dictionary's `staff:` key. Non-negative integer; 0 is real. */
  staffCount: number;
  /** Of those, the ones the co-author signal can match. Never exceeds `staffCount`. */
  staffTrackedCount: number;
};

export type CoreStaffMapResult = {
  /** Cores whose item was present and parseable — the ONLY cores to write. */
  writes: CoreStaffWrite[];
  /** Skipped: core_id could not be resolved from `PK` or the scalar. */
  skippedMissingCore: number;
  /** Skipped: core_id not in the seeded catalog (FK guard). */
  skippedUnknownCore: number;
  /** Skipped: `staff_count` absent, non-numeric, negative, or fractional. */
  skippedMissingCount: number;
  /** Skipped: `staff_tracked_count` absent, non-numeric, negative, or fractional. */
  skippedMissingTracked: number;
  /** Skipped: tracked > listed, which no dictionary entry can mean. */
  skippedIncoherent: number;
};

function parseCoreId(it: CoreStaffRecordInput): string {
  if (typeof it.PK === "string" && it.PK.startsWith("CORE#")) {
    const fromPk = it.PK.slice("CORE#".length).trim();
    if (fromPk) return fromPk;
  }
  return typeof it.core_id === "string" ? it.core_id.trim() : "";
}

/**
 * A count is only a count when it is a non-negative integer. Anything else
 * (absent, null, "", "many", -1, 2.5, NaN) is a MISSING count, not a zero:
 * returning 0 for an unparseable value would write "this core has no staff"
 * over a real roster on the strength of a malformed item.
 */
function parseCount(raw: number | string | undefined): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * Map CORE#/STAFF_DICT scan records to write payloads carrying BOTH counts.
 *
 * The two counts are all-or-nothing. An item that carries a listed count but
 * no usable tracked count is skipped outright rather than half-written,
 * because a row with `staff_count = 4, staff_tracked_count = NULL` is the one
 * state the UI cannot render honestly: it can neither claim the signal draws
 * on 4 nor claim it cannot fire. Skipping leaves both columns as they were and
 * the chip stays invisible, which is the fail-safe direction — a producer that
 * ships the listed count first and the tracked count later publishes nothing
 * until it publishes both, instead of publishing the misleading half.
 *
 * `tracked > listed` is rejected on the same grounds: the dictionary cannot
 * track staff it does not list, and rendering "7 of 4 core staff" would be a
 * visible lie about a number the reviewer is being asked to trust.
 *
 * Every guard SKIPS (counted, not thrown) so a malformed item on one core
 * cannot fail the nightly for the rest — and, critically, a skip emits no
 * write, so the existing column values survive untouched. Later items win on a
 * duplicate core id, matching the last-write-wins an upsert loop would give.
 */
export function buildCoreStaffWrites(
  records: ReadonlyArray<CoreStaffRecordInput>,
  sets: { knownCoreIds: ReadonlySet<string> },
): CoreStaffMapResult {
  const { knownCoreIds } = sets;
  const byCore = new Map<string, CoreStaffWrite>();
  let skippedMissingCore = 0;
  let skippedUnknownCore = 0;
  let skippedMissingCount = 0;
  let skippedMissingTracked = 0;
  let skippedIncoherent = 0;

  for (const it of records) {
    const coreId = parseCoreId(it);
    if (!coreId) {
      skippedMissingCore += 1;
      continue;
    }
    if (!knownCoreIds.has(coreId)) {
      skippedUnknownCore += 1;
      continue;
    }
    const staffCount = parseCount(it.staff_count);
    if (staffCount === null) {
      skippedMissingCount += 1;
      continue;
    }
    const staffTrackedCount = parseCount(it.staff_tracked_count);
    if (staffTrackedCount === null) {
      skippedMissingTracked += 1;
      continue;
    }
    if (staffTrackedCount > staffCount) {
      skippedIncoherent += 1;
      continue;
    }
    byCore.set(coreId, { coreId, staffCount, staffTrackedCount });
  }

  return {
    writes: [...byCore.values()],
    skippedMissingCore,
    skippedUnknownCore,
    skippedMissingCount,
    skippedMissingTracked,
    skippedIncoherent,
  };
}
