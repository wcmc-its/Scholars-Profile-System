/**
 * `etl/mentoring/import-copub-list.ts` — the parse half of the co-pub LIST
 * importer (the S3 read and the writes stay in `main`, which the `VITEST`
 * guard keeps from running on import). Protects the NDJSON contract: one
 * `{ mentorCwid, menteeCwid, pubs }` line per pair, flattened to one row per
 * (mentor, mentee, key); the key is the pub's `id` (round 5 — `SCOPUS:…` for
 * a Scopus-only article), else a positive-integer `pmid` as a string (an old
 * product); a bad line is skipped + counted; a pub with neither is dropped +
 * counted. Synthetic CWIDs only.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, disconnect: vi.fn() }));
vi.mock("../../lib/db", () => ({ db: { read: {}, write: {} }, disconnect: vi.fn() }));

import { parseNdjson } from "@/etl/mentoring/import-copub-list";

describe("parseNdjson (copub-list)", () => {
  it("keys on `id` when present (a Scopus-only row keeps its SCOPUS: key), else a positive pmid; neither is dropped + counted", () => {
    const text = [
      JSON.stringify({
        mentorCwid: " men0001 ",
        menteeCwid: "abc1234",
        pubs: [
          { id: "SCOPUS:105037533819", pmid: -4242, year: 2024, title: "A" },
          { pmid: 39887654, year: null },
          { pmid: -1 },
          null,
        ],
      }),
      "not json",
      JSON.stringify({ menteeCwid: "abc1234", pubs: [{ pmid: 1 }] }),
      "",
    ].join("\n");
    const { rows, skipped, droppedPubs } = parseNdjson(text);
    expect(skipped).toBe(2);
    expect(droppedPubs).toBe(2);
    expect(rows.map((r) => [r.mentorCwid, r.menteeCwid, r.pmid, r.pubYear])).toEqual([
      ["men0001", "abc1234", "SCOPUS:105037533819", 2024],
      ["men0001", "abc1234", "39887654", null],
    ]);
    expect(rows[0].pub).toEqual({ id: "SCOPUS:105037533819", pmid: -4242, year: 2024, title: "A" });
  });

  it("an empty artifact parses to zero rows (the floor guard's trigger)", () => {
    expect(parseNdjson("\n\n")).toEqual({ rows: [], skipped: 0, droppedPubs: 0 });
  });
});
