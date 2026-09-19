/**
 * `etl/orcid-registry` — the pure transforms behind the ORCID public-registry sweep:
 * union deduped by orcid-id, a shared mailbox never email-matches, name candidates and
 * the (unwidened) `namesMatch` gate, DOI/PMID extraction from `/works`, the ≥3-shared
 * "exactly one scholar" decision, and source precedence per (cwid, orcid). Synthetic
 * ids only (ORCID's doc example iD).
 */
import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  candidateNames,
  decide,
  dedupeRecords,
  emailToCwid,
  extractWorkIds,
  matchEmails,
  matchNames,
  mergeForScholars,
  type SourceRow,
} from "@/etl/orcid-registry/index";
import type { ExpandedResult } from "@/etl/orcid-registry/orcid-api";

const ORCID = "0000-0002-1825-0097";
const ORCID_2 = "0000-0002-1825-009X";

const rec = (over: Partial<ExpandedResult> = {}): ExpandedResult => ({
  "orcid-id": ORCID,
  "given-names": "John",
  "family-names": "Smith",
  "credit-name": null,
  "other-name": null,
  email: null,
  "institution-name": null,
  ...over,
});

describe("dedupeRecords", () => {
  it("unions query results by orcid-id, first occurrence wins", () => {
    const a = rec({ "credit-name": "first" });
    const out = dedupeRecords([[a], [rec({ "credit-name": "dup" }), rec({ "orcid-id": ORCID_2 })]]);
    expect(out.map((r) => [r["orcid-id"], r["credit-name"]])).toEqual([
      [ORCID, "first"],
      [ORCID_2, null],
    ]);
  });
});

describe("email match", () => {
  it("maps only emails held by exactly one scholar; a shared mailbox never matches", () => {
    const map = emailToCwid([
      { cwid: "abc1234", email: " ABC1234@example.edu " },
      { cwid: "def5678", email: "lab@example.edu" },
      { cwid: "ghi9012", email: "lab@example.edu" },
      { cwid: "jkl3456", email: null },
    ]);
    expect([...map]).toEqual([["abc1234@example.edu", "abc1234"]]);
    const { rows, matched } = matchEmails(
      [
        rec({ email: ["Abc1234@Example.edu"] }),
        rec({ "orcid-id": ORCID_2, email: ["lab@example.edu"] }),
      ],
      map,
    );
    expect(rows).toEqual([
      {
        cwid: "abc1234",
        orcid: ORCID,
        source: "orcid_email",
        articlesAccepted: 0,
        articlesRejected: 0,
        sourceUpdatedAt: null,
      },
    ]);
    expect([...matched]).toEqual([ORCID]);
  });
});

describe("name match", () => {
  it("tries credit-name, given+family, and each other-name", () => {
    expect(
      candidateNames(
        rec({ "credit-name": " J. A. Smith ", "other-name": ["Jack Smith", " ", "Smith JA"] }),
      ),
    ).toEqual(["J. A. Smith", "John Smith", "Jack Smith", "Smith JA"]);
    expect(candidateNames(rec({ "given-names": null }))).toEqual([]);
  });

  it("John Smith never matches Jane Smith; an initial (J A Smith) matches both and leaves it to the works step; preferredName counts", () => {
    const index = buildNameIndex([
      { cwid: "john1", fullName: "John A Smith", preferredName: "John Smith" },
      { cwid: "jane1", fullName: "Jane Smith", preferredName: "Jane Smith" },
      { cwid: "pref1", fullName: "Robert Q Jones", preferredName: "Bob Jones" },
    ]);
    const out = matchNames(
      [
        rec(), // John Smith
        rec({ "orcid-id": ORCID_2, "given-names": null, "credit-name": "J A Smith" }),
        rec({ "orcid-id": "0000-0001-0000-0003", "given-names": "Bob", "family-names": "Jones" }),
        rec({ "orcid-id": "0000-0001-0000-0004", "given-names": "Jane", "family-names": "Smith" }),
      ],
      index,
    );
    expect(out.get(ORCID)).toEqual(new Set(["john1"]));
    expect(out.get(ORCID_2)).toEqual(new Set(["john1", "jane1"]));
    expect(out.get("0000-0001-0000-0003")).toEqual(new Set(["pref1"]));
    expect(out.get("0000-0001-0000-0004")).toEqual(new Set(["jane1"]));
  });
});

describe("extractWorkIds", () => {
  it("collects DOIs (normalized, lowercased) and PMIDs from group and summary level, ignores pmc", () => {
    const ids = extractWorkIds({
      "last-modified-date": { value: 1 },
      group: [
        {
          "external-ids": {
            "external-id": [
              {
                "external-id-type": "doi",
                "external-id-value": "10.1000/ABC",
                "external-id-normalized": { value: "10.1000/abc" },
              },
              { "external-id-type": "pmc", "external-id-value": "PMC123", "external-id-normalized": null },
            ],
          },
          "work-summary": [
            {
              "external-ids": {
                "external-id": [
                  { "external-id-type": "pmid", "external-id-value": " 12345 ", "external-id-normalized": null },
                  { "external-id-type": "doi", "external-id-value": "10.1000/XyZ", "external-id-normalized": null },
                ],
              },
            },
          ],
        },
        { "external-ids": null, "work-summary": null },
      ],
    });
    expect([...ids].sort()).toEqual(["doi:10.1000/abc", "doi:10.1000/xyz", "pmid:12345"]);
  });
});

describe("decide", () => {
  const m = (o: Record<string, number>) => new Map(Object.entries(o));
  it("exactly one scholar with ≥3 shared → orcid_works, the others orcid_name", () => {
    expect(decide(m({ a1: 5, b2: 2, c3: 0 }))).toEqual([
      { cwid: "a1", source: "orcid_works", shared: 5 },
      { cwid: "b2", source: "orcid_name", shared: 2 },
      { cwid: "c3", source: "orcid_name", shared: 0 },
    ]);
  });
  it("two scholars with ≥3 → both orcid_name; 2 shared alone → orcid_name", () => {
    expect(decide(m({ a1: 3, b2: 4 })).map((d) => d.source)).toEqual(["orcid_name", "orcid_name"]);
    expect(decide(m({ a1: 2 }))).toEqual([{ cwid: "a1", source: "orcid_name", shared: 2 }]);
  });
});

describe("mergeForScholars", () => {
  it("drops unknown cwids and keeps one row per (cwid, orcid): email > works > name", () => {
    const row = (cwid: string, source: SourceRow["source"], n = 0): SourceRow => ({
      cwid,
      orcid: ORCID,
      source,
      articlesAccepted: n,
      articlesRejected: 0,
      sourceUpdatedAt: null,
    });
    const { keep, noScholar } = mergeForScholars(
      [row("a1", "orcid_name", 1), row("a1", "orcid_works", 4), row("a1", "orcid_email"), row("b2", "orcid_works", 3), row("b2", "orcid_name", 3), row("zz", "orcid_email")],
      new Set(["a1", "b2"]),
    );
    expect(noScholar).toBe(1);
    expect(keep.map((r) => [r.cwid, r.source, r.articlesAccepted])).toEqual([
      ["a1", "orcid_email", 0],
      ["b2", "orcid_works", 3],
    ]);
  });
});
