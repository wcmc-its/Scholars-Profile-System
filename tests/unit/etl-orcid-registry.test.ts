/**
 * `etl/orcid-registry` — the pure transforms behind the ORCID public-registry sweep:
 * union deduped by orcid-id, a shared mailbox never email-matches and a record naming
 * two scholars' emails settles nobody, name candidates and the (unwidened) `namesMatch`
 * gate, the full-given-name guard on top of it, DOI/PMID extraction from `/works`
 * (container ids skipped), the ≥3-shared + given-name "exactly one scholar" decision
 * with its exclusive-overlap tie-break, and source precedence per (cwid, orcid) within
 * the mirror. Synthetic ids only (ORCID's doc example iD).
 */
import { describe, expect, it } from "vitest";

import {
  buildNameIndex,
  candidateNames,
  decide,
  dedupeRecords,
  emailToCwid,
  extractWorkIds,
  givenNameKeys,
  givenNamesAgree,
  matchEmails,
  matchNames,
  mergeForScholars,
  type SourceRow,
  type WorksEvidence,
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
    const { rows, matched, ambiguous } = matchEmails(
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
    expect(ambiguous).toBe(0);
  });

  it("a record listing two scholars' emails settles nobody (no row, not matched); two emails of ONE scholar are one row", () => {
    const map = emailToCwid([
      { cwid: "abc1234", email: "abc1234@example.edu" },
      { cwid: "def5678", email: "lab-pi@example.edu" },
      { cwid: "ghi9012", email: "ghi9012@example.edu" },
    ]);
    const { rows, matched, ambiguous } = matchEmails(
      [
        // One iD, two emails, two different scholars — a lab address on someone else's row
        // must not tie the same iD to both of them (both would grade strong).
        rec({ email: ["abc1234@example.edu", "lab-pi@example.edu"] }),
        rec({ "orcid-id": ORCID_2, email: ["ghi9012@example.edu", "GHI9012@example.edu", "nobody@example.edu"] }),
      ],
      map,
    );
    expect(rows.map((r) => [r.cwid, r.orcid])).toEqual([["ghi9012", ORCID_2]]);
    expect([...matched]).toEqual([ORCID_2]);
    expect(ambiguous).toBe(1);
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

  it("givenNameKeys: full given tokens (≥2 letters, hyphens dropped) plus their concatenation; initials carry nothing", () => {
    expect(givenNameKeys("Xiao-Wei Wang")).toEqual(new Set(["xiaowei"]));
    expect(givenNameKeys("Xiao Wei Wang")).toEqual(new Set(["xiao", "wei", "xiaowei"]));
    expect(givenNameKeys("Xiaowei Wang")).toEqual(new Set(["xiaowei"]));
    expect(givenNameKeys("Mary J. Smith")).toEqual(new Set(["mary", "maryj"]));
    expect(givenNameKeys("J. A. Smith")).toEqual(new Set());
    expect(givenNameKeys("Smith")).toEqual(new Set());
  });

  it("givenNamesAgree: a full given name in common, via any record name and either scholar name; an initial is not enough", () => {
    const mary = { cwid: "mary1", fullName: "Mary J Smith", preferredName: "Mary Smith" };
    const john = { cwid: "john1", fullName: "John A Smith", preferredName: "John Smith" };
    const bob = { cwid: "pref1", fullName: "Robert Q Jones", preferredName: "Bob Jones" };
    // `namesMatch("J Smith", "Mary J Smith")` is true through the middle initial — the
    // works tier must not accept that.
    expect(givenNamesAgree(["J Smith"], mary)).toBe(false);
    expect(givenNamesAgree(["J Smith"], john)).toBe(false);
    expect(givenNamesAgree(["Jane Smith"], mary)).toBe(false);
    expect(givenNamesAgree(["John Smith"], john)).toBe(true);
    expect(givenNamesAgree(["J. Smith", "Smith JA", "John Adam Smith"], john)).toBe(true);
    expect(givenNamesAgree(["Bob Jones"], bob)).toBe(true); // preferredName
    expect(givenNamesAgree(["Xiao-Wei Wang"], { cwid: "w1", fullName: "Xiaowei Wang", preferredName: "Xiaowei Wang" })).toBe(true);
    expect(givenNamesAgree([], john)).toBe(false);
  });
});

describe("extractWorkIds", () => {
  it("collects DOIs (normalized, lowercased) and PMIDs from group and summary level; ignores pmc and part-of / version-of container ids", () => {
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
              // The book / proceedings volume this work sits in — not the person's work.
              {
                "external-id-type": "doi",
                "external-id-value": "10.1000/book",
                "external-id-normalized": { value: "10.1000/book" },
                "external-id-relationship": "part-of",
              },
            ],
          },
          "work-summary": [
            {
              "external-ids": {
                "external-id": [
                  { "external-id-type": "pmid", "external-id-value": " 12345 ", "external-id-normalized": null, "external-id-relationship": "self" },
                  { "external-id-type": "doi", "external-id-value": "10.1000/XyZ", "external-id-normalized": null },
                  { "external-id-type": "doi", "external-id-value": "10.1000/volume", "external-id-normalized": null, "external-id-relationship": "version-of" },
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
  // Shared works as id lists so the exclusive-overlap tie-break is testable; `n(k)` = k
  // distinct ids, `ids(...)` = a named set.
  const ids = (...xs: string[]) => new Set(xs);
  const n = (k: number, prefix = "w") => new Set(Array.from({ length: k }, (_, i) => `${prefix}${i}`));
  const ev = (o: Record<string, [Set<string>, boolean?]>) =>
    new Map<string, WorksEvidence>(
      Object.entries(o).map(([cwid, [shared, givenNameAgrees = true]]) => [cwid, { shared, givenNameAgrees }]),
    );
  it("exactly one scholar with ≥3 shared and a full given name → orcid_works, the others orcid_name", () => {
    expect(decide(ev({ a1: [n(5)], b2: [n(2)], c3: [n(0)] }))).toEqual([
      { cwid: "a1", source: "orcid_works", shared: 5 },
      { cwid: "b2", source: "orcid_name", shared: 2 },
      { cwid: "c3", source: "orcid_name", shared: 0 },
    ]);
  });
  it("≥3 shared on an initial-only name agreement is orcid_name however many works (the same-surname co-author of a departed owner)", () => {
    expect(decide(ev({ mary1: [n(40), false] }))).toEqual([{ cwid: "mary1", source: "orcid_name", shared: 40 }]);
    // …and it does not count as a competitor either: the full-name scholar still wins.
    expect(decide(ev({ mary1: [n(4), false], john1: [n(3)] })).map((d) => d.source)).toEqual([
      "orcid_name",
      "orcid_works",
    ]);
  });
  it("2 shared alone → orcid_name", () => {
    expect(decide(ev({ a1: [n(2)] }))).toEqual([{ cwid: "a1", source: "orcid_name", shared: 2 }]);
  });
  it("two confirmed scholars: the one with ≥3 works the iD shares with nobody else wins; a's joint papers do not demote b", () => {
    // a's 3 shared works are all papers co-authored with b (a ⊂ b) → b has 9 exclusive, a has 0.
    const joint = ids("j1", "j2", "j3");
    const bOnly = n(9, "b");
    expect(decide(ev({ a1: [joint], b2: [new Set([...joint, ...bOnly])] }))).toEqual([
      { cwid: "a1", source: "orcid_name", shared: 3 },
      { cwid: "b2", source: "orcid_works", shared: 12 },
    ]);
    // Both have ≥3 exclusive works → genuinely ambiguous → both orcid_name.
    expect(decide(ev({ a1: [n(3, "a")], b2: [n(4, "b")] })).map((d) => d.source)).toEqual([
      "orcid_name",
      "orcid_name",
    ]);
    // Neither has ≥3 exclusive (same 4 works) → both orcid_name.
    expect(decide(ev({ a1: [n(4)], b2: [n(4)] })).map((d) => d.source)).toEqual(["orcid_name", "orcid_name"]);
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
