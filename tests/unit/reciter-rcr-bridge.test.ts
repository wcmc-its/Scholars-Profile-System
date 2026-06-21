import { describe, expect, it } from "vitest";

import { parseRcrNdjson, serializeRcrNdjson, type RcrRow } from "@/etl/reciter-rcr/shared";

describe("RCR bridge NDJSON (#917 v6 follow-up)", () => {
  const rows: RcrRow[] = [
    { pmid: "12045110", rcr: 5.09, percentile: 92.5, citedBy: 339 },
    { pmid: "12127811", rcr: 0.07, percentile: 5.9, citedBy: 2 },
    { pmid: "99999999", rcr: null, percentile: null, citedBy: null },
  ];

  it("round-trips rows through serialize → parse", () => {
    const text = serializeRcrNdjson(rows);
    const { rows: out, skipped } = parseRcrNdjson(text);
    expect(skipped).toBe(0);
    expect(out).toEqual(rows);
  });

  it("skips blank + malformed lines and rows without a pmid", () => {
    const text = [
      JSON.stringify({ pmid: "1", rcr: 1.2, percentile: 50, citedBy: 10 }),
      "",
      "   ",
      "{ not json",
      JSON.stringify({ rcr: 9, percentile: 9, citedBy: 9 }), // no pmid
    ].join("\n");
    const { rows: out, skipped } = parseRcrNdjson(text);
    expect(out).toEqual([{ pmid: "1", rcr: 1.2, percentile: 50, citedBy: 10 }]);
    // malformed json (1) + the pmid-less row (1); blank/whitespace lines are not counted.
    expect(skipped).toBe(2);
  });

  it("coerces numeric pmid + string metrics to the typed shape", () => {
    const text = JSON.stringify({ pmid: 12345, rcr: "1.5", percentile: "10.2", citedBy: "7" });
    const { rows: out } = parseRcrNdjson(text);
    expect(out).toEqual([{ pmid: "12345", rcr: 1.5, percentile: 10.2, citedBy: 7 }]);
  });
});
