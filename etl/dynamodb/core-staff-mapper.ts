/**
 * Pure helper for etl/dynamodb/index.ts Block 6b (CORE#/STAFF -> core.staff_count),
 * split out so the per-record parsing + guards can be unit-tested without a
 * DynamoDB scan — the same split as ./publication-core-mapper.ts.
 *
 * ReciterAI writes one item per core at `PK = CORE#{core_id}`, `SK = STAFF`,
 * carrying `staff_count`: the number of CWIDs in that core's `staff:` list in
 * the facility dictionary. The COUNT ONLY, by contract — the consumer renders
 * one integer, and copying the staff CWIDs into a second datastore would be
 * PII surface bought for nothing. This mapper therefore reads exactly one
 * attribute and there is nothing here to mirror a roster with.
 *
 * Direction matters: this item flows ReciterAI -> SPS. The sibling
 * `(CORE#{core_id}, CLIENTS)` item flows the other way (SPS writes it in
 * lib/cores/client-writeback.ts, the engine reads it) and is never touched
 * here — ./partition.ts keeps them apart on the exact `SK`.
 *
 * ABSENT IS NOT ZERO. A core with no STAFF item must produce NO write at all,
 * leaving `core.staff_count` exactly as it was; a core whose item says
 * `staff_count: 0` must produce a write OF 0. That distinction is the whole
 * point of the nullable column: NULL reads as "not published yet" (the queue
 * shows no chip), 0 reads as "the dictionary lists no staff for this core"
 * (the queue says the staff co-author signal cannot fire). Collapsing the two
 * would be this repo's standing failure mode — a fail-soft read on a path that
 * WRITES is a wipe — so the mapper only ever emits writes for items it
 * actually saw, and every skip is counted rather than defaulted.
 */

/**
 * Minimal shape of a CORE#/STAFF record consumed by the mapper. The
 * DocumentClient scan unmarshals the attribute format, so a DynamoDB `N`
 * arrives as a JS number; the string form is accepted too because a hand-
 * written item (or a `PutItem` from a script) can land it as `S`.
 */
export type CoreStaffRecordInput = {
  PK: string; // "CORE#{core_id}"
  SK: string; // "STAFF"
  core_id?: string;
  staff_count?: number | string;
};

export type CoreStaffWrite = {
  coreId: string;
  /** The dictionary roster size. Always a non-negative integer; 0 is a real value. */
  staffCount: number;
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
function parseStaffCount(raw: number | string | undefined): number | null {
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
 * Map CORE#/STAFF scan records to `core.staff_count` write payloads.
 *
 * Every guard SKIPS (counted, not thrown) so a malformed item on one core
 * cannot fail the nightly for the rest — and, critically, a skip emits no
 * write, so the existing column value survives untouched. Later items win on a
 * duplicate core id, matching the last-write-wins an upsert loop would give.
 */
export function buildCoreStaffWrites(
  records: ReadonlyArray<CoreStaffRecordInput>,
  sets: { knownCoreIds: ReadonlySet<string> },
): CoreStaffMapResult {
  const { knownCoreIds } = sets;
  const byCore = new Map<string, number>();
  let skippedMissingCore = 0;
  let skippedUnknownCore = 0;
  let skippedMissingCount = 0;

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
    const staffCount = parseStaffCount(it.staff_count);
    if (staffCount === null) {
      skippedMissingCount += 1;
      continue;
    }
    byCore.set(coreId, staffCount);
  }

  return {
    writes: [...byCore].map(([coreId, staffCount]) => ({ coreId, staffCount })),
    skippedMissingCore,
    skippedUnknownCore,
    skippedMissingCount,
  };
}
