/**
 * `etl/orcid-authorship-impact` — the pure parts: row shaping (malformed iDs and
 * counts dropped, case variants of one iD summed), which source errors mean "not
 * ready" rather than an outage, and the never-wipe-on-an-empty-read decision.
 * Synthetic iDs only.
 */
import { describe, expect, it } from "vitest";

import {
  replaceDecision,
  sourceNotReadyReason,
  toOpenAuthorshipRows,
} from "@/etl/orcid-authorship-impact/index";

const A = "0000-0002-1825-0097";
const X = "0000-0002-1825-009X";

describe("toOpenAuthorshipRows", () => {
  it("keeps well-formed iDs with a positive count; trims and upper-cases the check digit", () => {
    const { rows, invalid } = toOpenAuthorshipRows([
      { orcid: ` ${A} `, openRows: 4 },
      // The driver may hand COUNT(*) back as a bigint or a string.
      { orcid: X.toLowerCase(), openRows: BigInt(2) },
      { orcid: X, openRows: "3" },
    ]);
    expect(invalid).toBe(0);
    expect(rows).toEqual([
      { orcid: A, openRows: 4 },
      // Two source groups that normalise to one iD are one row, summed.
      { orcid: X, openRows: 5 },
    ]);
  });

  it("drops a URL-form or malformed iD, a null iD, and a zero, negative or fractional count", () => {
    const { rows, invalid } = toOpenAuthorshipRows([
      { orcid: `https://orcid.org/${A}`, openRows: 1 },
      { orcid: "0000-0002-1825-009", openRows: 1 },
      { orcid: null, openRows: 7 },
      { orcid: "", openRows: 7 },
      { orcid: A, openRows: 0 },
      { orcid: A, openRows: -1 },
      { orcid: A, openRows: 1.5 },
      { orcid: A, openRows: null },
    ]);
    expect(rows).toEqual([]);
    expect(invalid).toBe(8);
  });
});

describe("sourceNotReadyReason", () => {
  it("names a missing table, a missing column and a denied SELECT", () => {
    expect(sourceNotReadyReason({ errno: 1146 })).toMatch(/does not exist/);
    expect(sourceNotReadyReason({ errno: 1054 })).toMatch(/byline_orcid/);
    expect(sourceNotReadyReason({ errno: 1142 })).toMatch(/denied/);
    expect(sourceNotReadyReason({ errno: 1143 })).toMatch(/denied/);
  });

  it("is null for anything else, so an outage still fails the step", () => {
    expect(sourceNotReadyReason({ errno: 1045 })).toBeNull(); // access denied for user (login)
    expect(sourceNotReadyReason({ errno: 2002 })).toBeNull();
    expect(sourceNotReadyReason(new Error("pool timeout"))).toBeNull();
    expect(sourceNotReadyReason(null)).toBeNull();
    expect(sourceNotReadyReason({ errno: "1146" })).toBeNull();
  });
});

describe("replaceDecision", () => {
  it("replaces on any non-empty read", () => {
    expect(replaceDecision(1, 0)).toBe("replace");
    expect(replaceDecision(1, 500)).toBe("replace");
  });

  it("refuses to replace a non-empty table with an empty read; an empty table is a no-op", () => {
    expect(replaceDecision(0, 500)).toBe("refuse");
    expect(replaceDecision(0, 0)).toBe("skip");
  });
});
