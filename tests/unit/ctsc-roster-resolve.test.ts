import { describe, expect, it } from "vitest";
import { parseCtscFeed, resolveCtscFeed, surnamesAgree, type CtscFeedRecord, type EdPerson } from "@/etl/ctsc-roster/resolve";

const ed = (uid: string, sn: string, retired = false): [string, EdPerson] => [
  uid,
  { uid, sn, displayName: `X ${sn}`, retired },
];
const edByUid = new Map([
  ed("abc1001", "Smith"),
  ed("varmus", "Varmus"),
  ed("old9001", "Jones", true),
  ed("new1002", "Jones"),
  ed("other1003", "Brown"),
  ed("amb1", "Lee"),
  ed("amb2", "Lee"),
]);
const edUidsByEmail = new Map([
  ["smith@med.cornell.edu", ["abc1001"]],
  ["jones@med.cornell.edu", ["new1002"]],
  ["brown@med.cornell.edu", ["other1003"]],
  ["lee@med.cornell.edu", ["amb1", "amb2"]],
]);
const scholars = new Set(["abc1001", "varmus", "new1002"]);
const rec = (PrimaryKey: number, o: Partial<CtscFeedRecord>): CtscFeedRecord => ({
  PrimaryKey,
  FirstName: "Pat",
  LastName: "Smith",
  ...o,
});

describe("resolveCtscFeed", () => {
  it("links a valid legacy letters-only CWID with no issue", () => {
    const r = resolveCtscFeed([rec(1, { CWID: "Varmus", LastName: "Varmus" })], edByUid, edUidsByEmail, scholars);
    expect(r.linkedCwids).toEqual(["varmus"]);
    expect(r.issues).toEqual([]);
  });

  it("resolves a blank CWID by email and suggests it", () => {
    const r = resolveCtscFeed([rec(2, { EMails: ["Smith@med.cornell.edu"] })], edByUid, edUidsByEmail, scholars);
    expect(r.linkedCwids).toEqual(["abc1001"]);
    expect(r.issues[0]).toMatchObject({ reason: "blank-resolved", suggestedCwid: "abc1001", matchedEmail: "smith@med.cornell.edu" });
  });

  it("does not link when the ED surname disagrees", () => {
    const r = resolveCtscFeed([rec(3, { EMails: ["brown@med.cornell.edu"] })], edByUid, edUidsByEmail, scholars);
    expect(r.linkedCwids).toEqual([]);
    expect(r.externals).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ reason: "email-match-name-differs", suggestedCwid: "other1003" });
  });

  it("replaces a retired CWID via email", () => {
    const r = resolveCtscFeed(
      [rec(4, { CWID: "old9001", LastName: "Jones", EMails: ["jones@med.cornell.edu"] })],
      edByUid, edUidsByEmail, scholars,
    );
    expect(r.linkedCwids).toEqual(["new1002"]);
    expect(r.issues[0]).toMatchObject({ reason: "retired-cwid", suggestedCwid: "new1002" });
  });

  it("flags a conflict but keeps the feed CWID", () => {
    const r = resolveCtscFeed(
      [rec(5, { CWID: "abc1001", LastName: "Brown", EMails: ["brown@med.cornell.edu"] })],
      edByUid, edUidsByEmail, scholars,
    );
    expect(r.linkedCwids).toEqual(["abc1001"]);
    expect(r.issues[0]).toMatchObject({ reason: "cwid-email-conflict", suggestedCwid: "other1003" });
  });

  it("flags ambiguous emails, not-in-ED CWIDs, and duplicates", () => {
    const r = resolveCtscFeed(
      [
        rec(6, { LastName: "Lee", EMails: ["lee@med.cornell.edu"] }),
        rec(7, { CWID: "zzz9999" }),
        rec(8, { CWID: "abc1001" }),
        rec(9, { CWID: "abc1001" }),
      ],
      edByUid, edUidsByEmail, scholars,
    );
    expect(r.issues.map((i) => [i.primaryKey, i.reason])).toEqual([
      [6, "email-ambiguous"],
      [7, "not-in-ed"],
      [9, "duplicate-record"],
    ]);
    expect(r.linkedCwids).toEqual(["abc1001"]);
    expect(r.externals.map((e) => e.cuid)).toEqual(["ctsc:6", "ctsc:7"]);
  });

  it("makes an in-ED person with no SPS profile a plain name, no issue", () => {
    const r = resolveCtscFeed([rec(10, { CWID: "other1003", LastName: "Brown", Institutions: ["Hospital for Special Surgery"] })], edByUid, edUidsByEmail, scholars);
    expect(r.linkedCwids).toEqual([]);
    expect(r.issues).toEqual([]);
    expect(r.externals[0]).toMatchObject({ cuid: "ctsc:10", affiliation: "Hospital for Special Surgery" });
  });
});

describe("parseCtscFeed", () => {
  it("normalizes the feed's digit-string PrimaryKey and drops unusable keys", () => {
    const r = parseCtscFeed({
      CTSCInvestigatorsAndTrainees: [
        { PrimaryKey: "123", LastName: "A" },
        { PrimaryKey: 7, LastName: "B" },
        { PrimaryKey: "x1", LastName: "C" },
        { LastName: "D" },
      ],
    });
    expect(r.map((x) => x.PrimaryKey)).toEqual([123, 7]);
  });

  it("throws on a body without the records array", () => {
    expect(() => parseCtscFeed({})).toThrow(/CTSCInvestigatorsAndTrainees/);
  });
});

describe("surnamesAgree", () => {
  it("folds accents and tolerates compound surnames", () => {
    expect(surnamesAgree("Núñez", "Nunez")).toBe(true);
    expect(surnamesAgree("Imperato McGinley", "Imperato-McGinley")).toBe(true);
    expect(surnamesAgree("Smith", "Brown")).toBe(false);
    expect(surnamesAgree("", "Brown")).toBe(false);
  });
});
