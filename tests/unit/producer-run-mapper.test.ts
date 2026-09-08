/**
 * Guards the four sharp edges of ReciterAI's stage ledger. Every fixture below
 * is a real row shape taken from a live scan of the `reciterai` table on
 * 2026-09-07 — the traps are not hypothetical, and three of them are invisible
 * to any fixture you would invent from the happy path.
 *
 * The last test is the "declared but never connected" guard: a mapper entry
 * with no matching TRACKED entry silently mirrors runs into a source the status
 * board never asks about, which looks exactly like working.
 */
import { describe, expect, it } from "vitest";
import {
  CORES_SOURCE,
  DRIFT_SOURCES,
  GRANTS_SOURCE,
  PRODUCER_STAGES,
  buildCoresRecencyWrite,
  buildDriftRunWrites,
  buildProducerRunWrites,
  buildRecencyWrite,
  latestCoreScoredAt,
  mapLedgerStatus,
} from "../../etl/dynamodb/producer-run-mapper";
import { TRACKED } from "../../lib/etl/freshness-policy";

const NONE = new Map<string, Date | null>();

describe("buildProducerRunWrites", () => {
  it("TRAP 1: a RUN#FAILED# row never outranks a later RUN#<date> row", () => {
    // Lexically "RUN#FAILED#2026-05-16…" > "RUN#2026-09-07…" because F > 9.
    // Taking the last SK reports hot_run as permanently failed; it is healthy.
    const writes = buildProducerRunWrites(
      [
        { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#FAILED#2026-05-16T03:11:04.425Z", status: "failed" },
        { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#2026-09-07T12:00:34Z", status: "complete" },
      ],
      NONE,
    );

    expect(writes.map((w) => w.status)).toEqual(["failed", "success"]);
    // Ascending by real time, so the newest row is the September success.
    const newest = writes[writes.length - 1];
    expect(newest.status).toBe("success");
    expect(newest.startedAt.toISOString()).toBe("2026-09-07T12:00:34.000Z");
  });

  it("TRAP 2: derives completedAt from duration_ms when completed_at is absent", () => {
    // Most `complete` rows carry no completed_at at all. Falling back to
    // startedAt would record the zero-length runs the started-at guard exists
    // to keep off the board.
    const [w] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#hot_run#GLOBAL",
          SK: "RUN#2026-09-07T12:00:34Z",
          status: "complete",
          duration_ms: 458,
        },
      ],
      NONE,
    );

    expect(w.completedAt.getTime() - w.startedAt.getTime()).toBe(458);
  });

  it("TRAP 2: prefers an explicit completed_at, and ignores one that precedes the start", () => {
    const [ok] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#daily_enrichment#GLOBAL",
          SK: "RUN#2026-09-07T11:01:13Z",
          status: "complete",
          completed_at: "2026-09-07T11:01:51Z",
          duration_ms: 5,
        },
      ],
      NONE,
    );
    expect(ok.completedAt.toISOString()).toBe("2026-09-07T11:01:51.000Z");

    // A completed_at BEFORE the start would render as a negative duration.
    const [bogus] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#daily_enrichment#GLOBAL",
          SK: "RUN#2026-09-07T11:01:13Z",
          status: "complete",
          completed_at: "2026-09-06T00:00:00Z",
          duration_ms: 900,
        },
      ],
      NONE,
    );
    expect(bogus.completedAt.getTime() - bogus.startedAt.getTime()).toBe(900);
  });

  it("TRAP 3: writes `skipped` verbatim so it is neither a success nor a failure", () => {
    // The real 2026-09-01 spotlight tick. Mapping this to success rebuilds the
    // blind spot; mapping it to failed cries wolf on correct behaviour.
    const [w] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#spotlight_refresh#GLOBAL",
          SK: "RUN#2026-09-01T13:01:43Z",
          status: "skipped",
          completed_at: "2026-09-01T13:01:43Z",
        },
      ],
      NONE,
    );

    expect(w.status).toBe("skipped");
    expect(w.status).not.toBe("success");
    expect(w.status).not.toBe("failed");
  });

  it("TRAP 3: freshness can still anchor on the last genuinely complete run", () => {
    // The shape that matters: a skip AFTER a complete. Only the complete row is
    // status:"success", which is the only row loadEtlStatus's success lookup
    // will see — so the age it reports is the age of real content.
    const writes = buildProducerRunWrites(
      [
        {
          PK: "STAGE#spotlight_refresh#GLOBAL",
          SK: "RUN#2026-08-07T14:35:06Z",
          status: "complete",
        },
        { PK: "STAGE#spotlight_refresh#GLOBAL", SK: "RUN#2026-09-01T13:01:43Z", status: "skipped" },
      ],
      NONE,
    );

    const successes = writes.filter((w) => w.status === "success");
    expect(successes).toHaveLength(1);
    expect(successes[0].startedAt.toISOString()).toBe("2026-08-07T14:35:06.000Z");
  });

  it("TRAP 4: keeps GLOBAL rows and drops per-cwid / per-pmid ones", () => {
    // The scoped rows here carry a TRACKED stage on purpose. Using an untracked
    // stage (rollup_by_cwid, score_publications) would let the PRODUCER_STAGES
    // lookup drop them and prove nothing about the scope filter -- a mutation
    // that deleted the filter outright still passed that version of this test.
    const writes = buildProducerRunWrites(
      [
        { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#2026-09-07T12:00:34Z", status: "complete" },
        // Thousands of these exist upstream; they are per-record work, not a
        // heartbeat, and one tracked stage growing them would flood etl_run.
        {
          PK: "STAGE#hot_run#cwid:abc1001",
          SK: "RUN#2026-09-07T12:03:23Z",
          status: "complete",
        },
        {
          PK: "STAGE#daily_enrichment#pmid:34316629",
          SK: "RUN#2026-09-07T11:01:13Z",
          status: "failed",
        },
      ],
      NONE,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].source).toBe("ReciterAI-hot-path");
  });

  it("still ignores scoped rows whose stage is not tracked at all", () => {
    const writes = buildProducerRunWrites(
      [
        {
          PK: "STAGE#rollup_by_cwid#cwid:abc1001",
          SK: "RUN#2026-09-07T12:03:23Z",
          status: "complete",
        },
        {
          PK: "STAGE#score_publications#pmid:34316629",
          SK: "RUN#2026-05-12T16:28:02Z",
          status: "failed",
        },
      ],
      NONE,
    );

    expect(writes).toEqual([]);
  });

  it("ignores GLOBAL stages that are not tracked producers", () => {
    // Real GLOBAL stages that are deliberately NOT in PRODUCER_STAGES: hot-path
    // substages and operator-run jobs with no schedule to be late against.
    const writes = buildProducerRunWrites(
      [
        {
          PK: "STAGE#compute_top_topic#GLOBAL",
          SK: "RUN#2026-09-07T12:02:44Z",
          status: "complete",
        },
        { PK: "STAGE#cold_run#GLOBAL", SK: "RUN#2026-05-13T14:41:44Z", status: "complete" },
        {
          PK: "STAGE#publish_hierarchy#GLOBAL",
          SK: "RUN#2026-08-01T19:34:05Z",
          status: "complete",
        },
      ],
      NONE,
    );

    expect(writes).toEqual([]);
  });

  it("maps the new cores_run stage onto the source cores is already graded under", () => {
    // ReciterAI is only now teaching pipeline_cores to write this row. The
    // source string has to be the SAME one the output-age tier uses, or the
    // ledger would open a second row on the board instead of taking over the
    // existing one — and the call-site preference below would have nothing to
    // match on.
    const [w] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#cores_run#GLOBAL",
          SK: "RUN#2026-09-08T05:00:11Z",
          status: "complete",
          duration_ms: 41204,
          records_written: 133,
        },
      ],
      NONE,
    );

    expect(w.source).toBe(CORES_SOURCE);
    expect(w.status).toBe("success");
    expect(w.rowsProcessed).toBe(133);
    expect(w.completedAt.getTime() - w.startedAt.getTime()).toBe(41204);
  });

  it("writes only runs newer than what is already recorded", () => {
    const rows = [
      { PK: "STAGE#daily_enrichment#GLOBAL", SK: "RUN#2026-09-05T11:01:22Z", status: "complete" },
      { PK: "STAGE#daily_enrichment#GLOBAL", SK: "RUN#2026-09-06T11:01:11Z", status: "complete" },
      { PK: "STAGE#daily_enrichment#GLOBAL", SK: "RUN#2026-09-07T11:01:13Z", status: "complete" },
    ];

    expect(buildProducerRunWrites(rows, NONE)).toHaveLength(3);

    const since = new Map([["ReciterAI-enrichment", new Date("2026-09-06T11:01:11Z")]]);
    const incremental = buildProducerRunWrites(rows, since);
    expect(incremental).toHaveLength(1);
    expect(incremental[0].startedAt.toISOString()).toBe("2026-09-07T11:01:13.000Z");

    // Re-running with the newest already recorded is a no-op, so the nightly is
    // idempotent and a retried run does not double-write.
    const caughtUp = new Map([["ReciterAI-enrichment", new Date("2026-09-07T11:01:13Z")]]);
    expect(buildProducerRunWrites(rows, caughtUp)).toEqual([]);
  });

  it("carries the error text on a failure, and nothing on a success", () => {
    const [failed, ok] = buildProducerRunWrites(
      [
        {
          PK: "STAGE#spotlight_refresh#GLOBAL",
          SK: "RUN#2026-08-07T14:08:01Z",
          status: "failed",
          error_code: "RuntimeError",
          error_message: "backfill_spotlight exited 1",
        },
        {
          PK: "STAGE#spotlight_refresh#GLOBAL",
          SK: "RUN#2026-08-07T14:35:06Z",
          status: "complete",
          records_written: 18,
        },
      ],
      NONE,
    );

    expect(failed.errorMessage).toBe("RuntimeError: backfill_spotlight exited 1");
    expect(ok.errorMessage).toBeNull();
    expect(ok.rowsProcessed).toBe(18);
  });

  it("survives the rows that would throw on write", () => {
    const writes = buildProducerRunWrites(
      [
        { PK: "STAGE#hot_run#GLOBAL", SK: "not-a-run-key", status: "complete" },
        { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#definitely-not-a-date", status: "complete" },
        { PK: "STAGE#hot_run", SK: "RUN#2026-09-07T12:00:34Z", status: "complete" },
        { PK: "GRANT#123", SK: "META" },
        // records_written arrives as a DynamoDB number; a string must not become NaN.
        {
          PK: "STAGE#hot_run#GLOBAL",
          SK: "RUN#2026-09-07T12:00:34Z",
          status: "complete",
          records_written: "7",
        },
      ],
      NONE,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].rowsProcessed).toBe(7);
  });

  it("keeps every status inside etl_run.status's VarChar(16)", () => {
    expect(mapLedgerStatus("complete")).toBe("success");
    expect(mapLedgerStatus("failed")).toBe("failed");
    expect(mapLedgerStatus("skipped")).toBe("skipped");
    expect(mapLedgerStatus("partial")).toBe("partial");
    expect(mapLedgerStatus(undefined)).toBe("unknown");
    // A future ledger word must not blow the column width.
    expect(mapLedgerStatus("a".repeat(40))).toHaveLength(16);
  });
});

describe("buildDriftRunWrites", () => {
  it("treats the row's existence as the liveness signal and anchors on window_end", () => {
    const [w] = buildDriftRunWrites(
      [
        {
          PK: "DRIFT#evaluation",
          SK: "DAY#2026-09-07",
          severity: "WARN",
          window_start: "2026-08-24T14:00:50Z",
          window_end: "2026-09-07T14:00:50Z",
        },
      ],
      NONE,
    );

    expect(w.source).toBe("ReciterAI-drift");
    expect(w.status).toBe("success");
    expect(w.startedAt.toISOString()).toBe("2026-09-07T14:00:50.000Z");
  });

  it("does NOT grade severity — WARN is about the data, not the run", () => {
    // DRIFT#evaluation has read WARN on all 106 rows it has ever written. If
    // severity drove status this row would be permanently red for a Lambda that
    // has never failed to run.
    const writes = buildDriftRunWrites(
      [
        {
          PK: "DRIFT#evaluation",
          SK: "DAY#2026-09-07",
          severity: "WARN",
          window_end: "2026-09-07T14:00:50Z",
        },
        {
          PK: "DRIFT#taxonomy",
          SK: "DAY#2026-09-07",
          severity: "OK",
          window_end: "2026-09-07T15:00:12Z",
        },
      ],
      NONE,
    );

    expect(writes.map((w) => w.status)).toEqual(["success", "success"]);
    expect(writes.map((w) => w.source)).toEqual(["ReciterAI-drift", "ReciterAI-taxonomy-drift"]);
  });

  it("never anchors on window_start — that is the drift window, not the run", () => {
    // window_start is 14 days back; using it would report a 14-day-old run every
    // day and read as permanently late.
    const [w] = buildDriftRunWrites(
      [
        {
          PK: "DRIFT#taxonomy",
          SK: "DAY#2026-09-07",
          window_start: "2026-08-24T14:00:50Z",
          window_end: "2026-09-07T14:00:50Z",
        },
      ],
      NONE,
    );

    expect(w.startedAt.toISOString()).not.toBe("2026-08-24T14:00:50.000Z");
    expect(w.startedAt.toISOString()).toBe("2026-09-07T14:00:50.000Z");
  });

  it("falls back to the DAY# key when window_end is missing, and skips junk", () => {
    const writes = buildDriftRunWrites(
      [
        { PK: "DRIFT#taxonomy", SK: "DAY#2026-09-07" },
        { PK: "DRIFT#taxonomy", SK: "DAY#not-a-date" },
        { PK: "DRIFT#unknown-kind", SK: "DAY#2026-09-07" },
        { PK: "STAGE#hot_run#GLOBAL", SK: "RUN#2026-09-07T12:00:34Z" },
      ],
      NONE,
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].startedAt.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("ends the run at started + duration_ms once the producer supplies one", () => {
    const [w] = buildDriftRunWrites(
      [
        {
          PK: "DRIFT#evaluation",
          SK: "DAY#2026-09-08",
          window_end: "2026-09-08T14:00:50Z",
          duration_ms: 1842,
        },
      ],
      NONE,
    );

    expect(w.completedAt.getTime() - w.startedAt.getTime()).toBe(1842);
  });

  // The 106 + 33 rows already in the table predate `duration_ms`, so its absence
  // has to stay a no-op. A junk or non-positive value takes the same path rather
  // than writing a completion at or before the start.
  it("keeps today's zero-length shape when duration_ms is absent or unusable", () => {
    const rows = [
      { PK: "DRIFT#evaluation", SK: "DAY#2026-09-08", window_end: "2026-09-08T14:00:50Z" },
      {
        PK: "DRIFT#taxonomy",
        SK: "DAY#2026-09-08",
        window_end: "2026-09-08T15:00:12Z",
        duration_ms: "not-a-number",
      },
      {
        PK: "DRIFT#taxonomy",
        SK: "DAY#2026-09-07",
        window_end: "2026-09-07T15:00:12Z",
        duration_ms: 0,
      },
      {
        PK: "DRIFT#taxonomy",
        SK: "DAY#2026-09-06",
        window_end: "2026-09-06T15:00:12Z",
        duration_ms: -5000,
      },
    ];

    const writes = buildDriftRunWrites(rows, NONE);
    expect(writes).toHaveLength(4);
    for (const w of writes) {
      expect(w.completedAt.getTime()).toBe(w.startedAt.getTime());
    }
  });

  it("writes only evaluations newer than what is already recorded", () => {
    const rows = [
      { PK: "DRIFT#evaluation", SK: "DAY#2026-09-06", window_end: "2026-09-06T14:00:50Z" },
      { PK: "DRIFT#evaluation", SK: "DAY#2026-09-07", window_end: "2026-09-07T14:00:50Z" },
    ];
    expect(buildDriftRunWrites(rows, NONE)).toHaveLength(2);

    const since = new Map([["ReciterAI-drift", new Date("2026-09-06T14:00:50Z")]]);
    expect(buildDriftRunWrites(rows, since)).toHaveLength(1);

    const caughtUp = new Map([["ReciterAI-drift", new Date("2026-09-07T14:00:50Z")]]);
    expect(buildDriftRunWrites(rows, caughtUp)).toEqual([]);
  });
});

describe("latestCoreScoredAt / buildRecencyWrite (the output-age tier)", () => {
  it("takes the newest scored_at, not the last one in the array", () => {
    const at = latestCoreScoredAt([
      { PK: "PUB#1", SK: "CORE#14", scored_at: "2026-09-07T15:57:36Z" },
      { PK: "PUB#2", SK: "CORE#14", scored_at: "2026-06-22T10:00:00Z" },
      { PK: "PUB#3", SK: "CORE#14", scored_at: "2026-09-03T08:00:00Z" },
    ]);

    expect(at?.toISOString()).toBe("2026-09-07T15:57:36.000Z");
  });

  it("ignores rows with a missing or unparseable scored_at", () => {
    expect(latestCoreScoredAt([{ PK: "PUB#1", SK: "CORE#14" }])).toBeNull();
    expect(
      latestCoreScoredAt([{ PK: "PUB#1", SK: "CORE#14", scored_at: "not-a-date" }]),
    ).toBeNull();
    expect(latestCoreScoredAt([])).toBeNull();
  });

  it("writes one row, and none at all when there is no anchor", () => {
    expect(buildRecencyWrite(CORES_SOURCE, null, NONE)).toEqual([]);

    const [w] = buildRecencyWrite(CORES_SOURCE, new Date("2026-09-07T15:57:36Z"), NONE);
    expect(w.source).toBe(CORES_SOURCE);
    expect(w.status).toBe("success");
    expect(w.startedAt.toISOString()).toBe("2026-09-07T15:57:36.000Z");
  });

  it("adds NO row when the anchor has not moved — a quiet producer just ages", () => {
    // This is what keeps it idempotent across nightlies. Writing a fresh row
    // every night with an unchanged anchor would make a frozen producer look
    // like it reported in daily, which is the exact failure being fixed.
    const at = new Date("2026-09-07T05:00:00Z");
    const caughtUp = new Map([[CORES_SOURCE, at]]);
    expect(buildRecencyWrite(CORES_SOURCE, at, caughtUp)).toEqual([]);

    const stale = new Map([[CORES_SOURCE, new Date("2026-09-08T05:00:00Z")]]);
    expect(buildRecencyWrite(CORES_SOURCE, at, stale)).toEqual([]);

    const behind = new Map([[CORES_SOURCE, new Date("2026-09-06T05:00:00Z")]]);
    expect(buildRecencyWrite(CORES_SOURCE, at, behind)).toHaveLength(1);
  });

  it("keeps the two output-age sources independent of each other", () => {
    const since = new Map([[CORES_SOURCE, new Date("2026-09-07T05:00:00Z")]]);
    // Grants has no entry in `since`, so its first row still lands even though
    // cores is caught up.
    expect(buildRecencyWrite(GRANTS_SOURCE, new Date("2026-09-07T05:58:15Z"), since)).toHaveLength(
      1,
    );
  });
});

/**
 * The double-write trap. `cores_run` and `latestCoreScoredAt` describe the same
 * nightly job and resolve to the same `etl_run.source`, so a call site that ran
 * both would file two rows for one run — and the output-age row would keep the
 * watermark moving on a night the run died, which is the blind spot the whole
 * module exists to close.
 */
describe("buildCoresRecencyWrite (ledger beats output age)", () => {
  const coresAt = new Date("2026-09-08T05:41:00Z");
  const coresLedger = [
    { PK: "STAGE#cores_run#GLOBAL", SK: "RUN#2026-09-08T05:00:11Z", status: "complete" },
  ];

  it("drops the output-age row once the ledger carries a cores run record", () => {
    expect(buildCoresRecencyWrite(coresLedger, coresAt, NONE)).toEqual([]);
  });

  it("still writes the output-age row while no ledger row exists — today's behaviour", () => {
    // Until ReciterAI deploys, the scan contains no cores_run row, so this must
    // be identical to the bare buildRecencyWrite call it replaced.
    expect(buildCoresRecencyWrite([], coresAt, NONE)).toEqual(
      buildRecencyWrite(CORES_SOURCE, coresAt, NONE),
    );
    expect(buildCoresRecencyWrite([], coresAt, NONE)).toHaveLength(1);
  });

  it("keeps the watermark and the null-anchor rules it inherits", () => {
    expect(buildCoresRecencyWrite([], null, NONE)).toEqual([]);
    const caughtUp = new Map([[CORES_SOURCE, coresAt]]);
    expect(buildCoresRecencyWrite([], coresAt, caughtUp)).toEqual([]);
  });

  it("is not suppressed by some OTHER producer's ledger row", () => {
    // The guard must match on the cores PK, not merely on the ledger being
    // non-empty; a scan carrying enrichment but not cores still needs the
    // output-age fallback.
    const otherProducer = [
      { PK: "STAGE#daily_enrichment#GLOBAL", SK: "RUN#2026-09-08T11:01:13Z", status: "complete" },
    ];
    expect(buildCoresRecencyWrite(otherProducer, coresAt, NONE)).toHaveLength(1);
  });

  it("is not suppressed by a cores ledger row under a NON-GLOBAL scope", () => {
    // Only GLOBAL is a pipeline heartbeat (trap 4). A per-record row must not
    // retire the fallback.
    const scoped = [
      { PK: "STAGE#cores_run#pmid:123", SK: "RUN#2026-09-08T05:00:11Z", status: "complete" },
    ];
    expect(buildCoresRecencyWrite(scoped, coresAt, NONE)).toHaveLength(1);
  });

  // ---- the two scenarios a writes-keyed guard got wrong -------------------
  // Both turn on the same fact: buildProducerRunWrites drops a ledger row at or
  // below the watermark, so "the ledger produced no write this pass" does NOT
  // mean "there is no ledger". Keying on the scanned rows is what fixes them.

  it("files no second row when the nightly is re-run the same day", () => {
    // Pass 1 mirrored the 05:00 ledger row, so `since` now sits at its
    // startedAt. `scored_at` on the rows that same run wrote is LATER, so an
    // output-age row would clear the watermark and double-count one run.
    const since = new Map([[CORES_SOURCE, new Date("2026-09-08T05:00:11Z")]]);
    expect(buildProducerRunWrites(coresLedger, since)).toEqual([]); // already mirrored
    expect(buildCoresRecencyWrite(coresLedger, coresAt, since)).toEqual([]);
  });

  it("files no success row on a night cores died", () => {
    // No NEW ledger row, and yesterday's scored_at still sits above the
    // watermark — so the fallback would file a `success` for a run that never
    // happened. That is the blind spot this module exists to close.
    const since = new Map([[CORES_SOURCE, new Date("2026-09-07T05:00:11Z")]]);
    const staleAnchor = new Date("2026-09-07T05:41:00Z");
    expect(buildCoresRecencyWrite(coresLedger, staleAnchor, since)).toEqual([]);
  });
});

describe("producer stage wiring", () => {
  it("every mirrored source is TRACKED — otherwise the board never asks for it", () => {
    // Mirroring runs into a source the status page does not read is the
    // "declared but never connected" failure: it looks exactly like working.
    for (const source of [
      ...Object.values(PRODUCER_STAGES),
      ...Object.values(DRIFT_SOURCES),
      CORES_SOURCE,
      GRANTS_SOURCE,
    ]) {
      expect(TRACKED, `${source} is mirrored but not TRACKED`).toHaveProperty(source);
    }
  });

  it("covers all eight scheduled ReciterAI jobs", () => {
    // The count is the point of the last three PRs. If a source is dropped here
    // the board silently stops asking about one of the eight, which is exactly
    // the invisible state this work exists to end.
    const covered = new Set([
      ...Object.values(PRODUCER_STAGES),
      ...Object.values(DRIFT_SOURCES),
      CORES_SOURCE,
      GRANTS_SOURCE,
    ]);
    expect(covered).toEqual(
      new Set([
        "ReciterAI-enrichment", // reciterai-enrichment-daily
        "ReciterAI-hot-path", // reciterai-hot-weekly
        "ReciterAI-spotlight-gate", // reciterai-spotlight-monthly
        "ReciterAI-onboarding-detector", // reciterai-onboarding-detector-daily
        "ReciterAI-drift", // reciterai-drift-daily
        "ReciterAI-taxonomy-drift", // reciterai-taxonomy-drift-daily
        "ReciterAI-cores", // reciterai-cores-daily
        "ReciterAI-grants", // reciterai-grants-daily
      ]),
    );
  });

  it("maps each stage to a distinct source", () => {
    const sources = Object.values(PRODUCER_STAGES);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
