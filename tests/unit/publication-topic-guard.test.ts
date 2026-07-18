/**
 * Post-Block-2 regression guard for `etl/dynamodb` (issue #91).
 *
 * Issue #91: subtopic pages rendered empty because the TOPIC# ->
 * publication_topic projection had never landed its rows, yet the ETL
 * still reported success. `assertPublicationTopicPopulated` is the gate
 * that now fails such a run. Covers:
 *   - Healthy run (table populated, rows upserted) — no throw
 *   - Empty table with upstream data present — throws (literal #91 cause)
 *   - Empty table with an empty scan — throws
 *   - Scan returned records but zero upserted, stale table — throws
 *   - Zero scanned, table non-empty — throws (full scan ⇒ source gone,
 *     no quiet-day case; issue in the 2026-07-17 handoff §1.3)
 *   - Minimal non-empty table (one row) — no throw
 *   - Partial-but-positive upsert — no throw (the guard has no partial floor)
 */
import { describe, expect, it } from "vitest";
import { assertPublicationTopicPopulated } from "@/etl/dynamodb/publication-topic-guard";

describe("assertPublicationTopicPopulated (#91 Block 2 guard)", () => {
  it("passes a healthy run — table populated, rows upserted this run", () => {
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 78103,
        scannedCount: 78103,
        upsertedCount: 78103,
      }),
    ).not.toThrow();
  });

  it("throws when publication_topic is empty though upstream TOPIC# data exists (literal #91 cause)", () => {
    // The scan returned 78k records but every one was skipped, so the
    // table stayed empty — exactly "Block 2 hadn't landed its rows".
    // Mode 1 is checked before mode 2, so this reports as an empty table.
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 0,
        scannedCount: 78103,
        upsertedCount: 0,
      }),
    ).toThrow(/publication_topic is empty/);
  });

  it("throws on an empty table when the scan also returned nothing", () => {
    // ETL ran against an empty or misnamed source table — nothing
    // scanned, nothing upserted, table empty. Still a regression.
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 0,
        scannedCount: 0,
        upsertedCount: 0,
      }),
    ).toThrow(/publication_topic is empty/);
  });

  it("throws when the scan returned records but none were upserted (stale table)", () => {
    // publication_topic still holds prior-run rows, so the empty-table
    // check stays quiet — but a 78k-record scan landing zero rows means
    // every row hit an FK/field guard and the projection is broken.
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 78103,
        scannedCount: 78103,
        upsertedCount: 0,
      }),
    ).toThrow(/rejected by an FK\/field guard/);
  });

  it("throws when zero were scanned against a non-empty table — full scan, source gone", () => {
    // Block 2 feeds off an unfiltered full-table scan, so scannedCount === 0
    // means the TOPIC# rows vanished or the TABLE env is wrong — NOT a quiet
    // day. The table still holds prior-run rows, but freezing on stale data
    // is the silent-staleness trap this guard exists to catch (handoff §1.3).
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 78103,
        scannedCount: 0,
        upsertedCount: 0,
      }),
    ).toThrow(/full-table scan returned zero TOPIC# records/);
  });

  it("treats a single row as a non-empty table (boundary)", () => {
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 1,
        scannedCount: 1,
        upsertedCount: 1,
      }),
    ).not.toThrow();
  });

  it("does not throw on a partial-but-positive upsert — the guard has no partial floor", () => {
    // The guard fails on zero, not on "fewer than expected". A partial
    // upsert still keeps subtopic pages working, and thresholding a
    // partial count would need a per-run baseline the ETL doesn't track.
    expect(() =>
      assertPublicationTopicPopulated({
        tableCount: 50000,
        scannedCount: 78103,
        upsertedCount: 200,
      }),
    ).not.toThrow();
  });
});
