/**
 * `etl/orcid-candidates` — the pure transforms behind the RPM ORCID-candidate mirror:
 * malformed ORCIDs dropped, cwids normalised, only known scholars kept, and an admin row
 * winning over an inferred row for the same (cwid, orcid). Synthetic ids only.
 */
import { describe, expect, it } from "vitest";

import { mergeForScholars, toCandidates } from "@/etl/orcid-candidates/index";

const GOOD = "0000-0002-1825-0097";
const GOOD_X = "0000-0002-1825-009X";

describe("toCandidates", () => {
  it("keeps well-formed ORCIDs (incl. the X check digit), trims + lowercases, counts the rest as invalid", () => {
    const { rows, invalid } = toCandidates(
      [
        {
          personIdentifier: " ABC1234 ",
          orcid: ` ${GOOD} `,
          articles_accepted: 5,
          articles_rejected: null,
          updated_at: "2026-02-17T02:49:22.000Z",
        },
        {
          personIdentifier: "abc1234",
          orcid: "0000-0002-1825-0097-",
          articles_accepted: 1,
          articles_rejected: 0,
          updated_at: null,
        },
        {
          personIdentifier: "abc1234",
          orcid: null,
          articles_accepted: 1,
          articles_rejected: 0,
          updated_at: null,
        },
      ],
      [
        { personIdentifier: "DEF5678", orcid: GOOD_X },
        { personIdentifier: "def5678", orcid: "not-an-orcid" },
      ],
    );
    expect(invalid).toBe(3);
    expect(rows).toEqual([
      {
        cwid: "abc1234",
        orcid: GOOD,
        source: "rpm_inferred",
        articlesAccepted: 5,
        articlesRejected: 0,
        sourceUpdatedAt: new Date("2026-02-17T02:49:22.000Z"),
      },
      {
        cwid: "def5678",
        orcid: GOOD_X,
        source: "rpm_admin",
        articlesAccepted: 0,
        articlesRejected: 0,
        sourceUpdatedAt: null,
      },
    ]);
  });
});

describe("mergeForScholars", () => {
  it("drops unknown cwids, dedupes on (cwid, orcid), and lets an admin row beat an inferred one either way round", () => {
    const inf = (cwid: string, orcid: string) => ({
      cwid,
      orcid,
      source: "rpm_inferred" as const,
      articlesAccepted: 4,
      articlesRejected: 0,
      sourceUpdatedAt: null,
    });
    const adm = (cwid: string, orcid: string) => ({
      cwid,
      orcid,
      source: "rpm_admin" as const,
      articlesAccepted: 0,
      articlesRejected: 0,
      sourceUpdatedAt: null,
    });
    const { keep, noScholar } = mergeForScholars(
      [
        inf("a1", GOOD),
        adm("a1", GOOD),
        adm("b2", GOOD_X),
        inf("b2", GOOD_X),
        inf("b2", GOOD),
        inf("zz", GOOD),
      ],
      new Set(["a1", "b2"]),
    );
    expect(noScholar).toBe(1);
    expect(keep.map((r) => [r.cwid, r.orcid, r.source])).toEqual([
      ["a1", GOOD, "rpm_admin"],
      ["b2", GOOD_X, "rpm_admin"],
      ["b2", GOOD, "rpm_inferred"],
    ]);
  });
});
