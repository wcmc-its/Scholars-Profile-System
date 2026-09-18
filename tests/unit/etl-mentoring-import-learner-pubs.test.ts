/**
 * `etl/mentoring/import-learner-pubs.ts` — the parse half of the learner
 * full-publication-list importer (the S3 read and the writes stay in `main`,
 * which the `VITEST` guard keeps from running on import). Protects the NDJSON
 * contract: one `{ menteeCwid, pubs }` line per learner, flattened to one row
 * per (learner, pmid); a bad line is skipped + counted; a pub without a valid
 * positive-integer pmid is dropped + counted; a repeated (learner, pmid)
 * collapses (last wins). Synthetic CWIDs only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, disconnect: vi.fn() }));
vi.mock("../../lib/db", () => ({ db: { read: {}, write: {} }, disconnect: vi.fn() }));

import { parseLearnerPubsNdjson } from "@/etl/mentoring/import-learner-pubs";

describe("parseLearnerPubsNdjson", () => {
  it("flattens one line per learner to one row per (learner, pmid), keeping the pub JSON and year", () => {
    const text = [
      JSON.stringify({
        menteeCwid: " abc1234 ",
        pubs: [
          { pmid: 11, year: 2024, title: "A" },
          { pmid: 12, year: null },
        ],
      }),
      "",
      JSON.stringify({ menteeCwid: "def5678", pubs: [{ pmid: 11, year: 2024 }] }),
    ].join("\n");
    const { rows, skipped, droppedPubs } = parseLearnerPubsNdjson(text);
    expect(skipped).toBe(0);
    expect(droppedPubs).toBe(0);
    expect(rows.map((r) => [r.menteeCwid, r.pmid, r.pubYear])).toEqual([
      ["abc1234", 11, 2024],
      ["abc1234", 12, null],
      ["def5678", 11, 2024],
    ]);
    expect(rows[0].pub).toEqual({ pmid: 11, year: 2024, title: "A" });
  });

  it("skips a malformed / cwid-less / non-array line, drops a pmid-less pub, collapses a repeated key", () => {
    const text = [
      "not json",
      JSON.stringify({ pubs: [{ pmid: 1 }] }),
      JSON.stringify({ menteeCwid: "abc1234", pubs: "nope" }),
      JSON.stringify({
        menteeCwid: "abc1234",
        pubs: [{ pmid: 0 }, { pmid: "7" }, null, { pmid: 7, year: 2020 }],
      }),
      JSON.stringify({ menteeCwid: "abc1234", pubs: [{ pmid: 7, year: 2021 }] }),
    ].join("\n");
    const { rows, skipped, droppedPubs } = parseLearnerPubsNdjson(text);
    expect(skipped).toBe(3);
    expect(droppedPubs).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ menteeCwid: "abc1234", pmid: 7, pubYear: 2021 });
  });

  it("an empty artifact parses to zero rows (the floor guard's trigger)", () => {
    expect(parseLearnerPubsNdjson("\n\n")).toEqual({ rows: [], skipped: 0, droppedPubs: 0 });
  });
});
