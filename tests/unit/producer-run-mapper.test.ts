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
  PRODUCER_STAGES,
  buildProducerRunWrites,
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

describe("producer stage wiring", () => {
  it("every mirrored source is TRACKED — otherwise the board never asks for it", () => {
    // Mirroring runs into a source the status page does not read is the
    // "declared but never connected" failure: it looks exactly like working.
    for (const source of Object.values(PRODUCER_STAGES)) {
      expect(TRACKED, `${source} is mirrored but not TRACKED`).toHaveProperty(source);
    }
  });

  it("maps each stage to a distinct source", () => {
    const sources = Object.values(PRODUCER_STAGES);
    expect(new Set(sources).size).toBe(sources.length);
  });
});
