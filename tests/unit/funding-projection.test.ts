import { describe, expect, it } from "vitest";
import { projectFromRows, type GrantRowForIndex } from "@/lib/funding-projection";

const SCHOLAR_A = {
  slug: "alice-aaron",
  preferredName: "Alice Aaron",
  primaryDepartment: "Medicine",
};
const SCHOLAR_B = {
  slug: "bob-baker",
  preferredName: "Bob Baker",
  primaryDepartment: "Surgery",
};
const SCHOLAR_C = {
  slug: "carol-coe",
  preferredName: "Carol Coe",
  primaryDepartment: "Medicine",
};

function makeRow(
  overrides: Partial<GrantRowForIndex> & {
    cwid: string;
    role: string;
  } & Pick<GrantRowForIndex, "scholar">,
): GrantRowForIndex {
  return {
    externalId: `INFOED-ACC-001-${overrides.cwid}`,
    title: "Modeling outcomes in cardiology cohorts",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2027-01-01"),
    awardNumber: "R01 HL123456",
    programType: "Grant",
    primeSponsor: "NHLBI",
    primeSponsorRaw: "National Heart, Lung, and Blood Institute",
    directSponsor: null,
    directSponsorRaw: null,
    mechanism: "R01",
    nihIc: "NHLBI",
    isSubaward: false,
    ...overrides,
  };
}

describe("projectFromRows", () => {
  it("returns null when given an empty list", () => {
    expect(projectFromRows([])).toBeNull();
  });

  it("returns null when externalId can't be parsed", () => {
    const row = makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A });
    row.externalId = "garbage";
    expect(projectFromRows([row])).toBeNull();
  });

  it("collapses one PI row into a single-person project", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
    ])!;
    expect(doc.projectId).toBe("ACC-001");
    expect(doc.totalPeople).toBe(1);
    expect(doc.people[0].cwid).toBe("alice");
    expect(doc.roles).toEqual(["PI"]);
    expect(doc.isMultiPi).toBe(false);
  });

  it("flags Multi-PI when ≥2 PI rows share the project", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
      makeRow({ cwid: "bob", role: "PI", scholar: SCHOLAR_B }),
      makeRow({ cwid: "carol", role: "Co-I", scholar: SCHOLAR_C }),
    ])!;
    expect(doc.isMultiPi).toBe(true);
    expect(new Set(doc.roles)).toEqual(new Set(["PI", "Multi-PI", "Co-I"]));
    // Lead-PI (alice — first PI in sort order) drives department.
    expect(doc.department).toBe("Medicine");
  });

  it("orders people lead-PI first, then Co-PI, then Co-I", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "carol", role: "Co-I", scholar: SCHOLAR_C }),
      makeRow({ cwid: "bob", role: "Co-PI", scholar: SCHOLAR_B }),
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
    ])!;
    expect(doc.people.map((p) => p.cwid)).toEqual(["alice", "bob", "carol"]);
  });

  it("populates sponsorText with canonical short, full, aliases, and raw", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
    ])!;
    expect(doc.sponsorText).toContain("NHLBI");
    expect(doc.sponsorText).toContain("National Heart, Lung, and Blood Institute");
  });

  it("emits directSponsor only when isSubaward is true", () => {
    const subaward = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        primeSponsor: "NCI",
        primeSponsorRaw: "National Cancer Institute",
        directSponsor: null,
        directSponsorRaw: "Duke University",
        isSubaward: true,
      }),
    ])!;
    expect(subaward.isSubaward).toBe(true);
    expect(subaward.directSponsor).toBe("Duke University");
    expect(subaward.primeSponsor).toBe("NCI");

    const direct = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
    ])!;
    expect(direct.isSubaward).toBe(false);
    expect(direct.directSponsor).toBeNull();
  });

  it("falls back to runtime canonicalization when stored prime is null", () => {
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        primeSponsor: null,
        primeSponsorRaw: "National Cancer Institute",
      }),
    ])!;
    expect(doc.primeSponsor).toBe("NCI");
  });

  it("falls back to raw when no canonical lookup matches", () => {
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        primeSponsor: null,
        primeSponsorRaw: "Some Obscure Sponsor",
      }),
    ])!;
    expect(doc.primeSponsor).toBe("Some Obscure Sponsor");
  });

  it("populates peopleNames with every WCM scholar's preferredName", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
      makeRow({ cwid: "bob", role: "Co-I", scholar: SCHOLAR_B }),
    ])!;
    expect(doc.peopleNames).toContain("Alice Aaron");
    expect(doc.peopleNames).toContain("Bob Baker");
  });

  it("populates wcmInvestigatorCwids with every WCM scholar's CWID (issue #94)", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "alice", role: "PI", scholar: SCHOLAR_A }),
      makeRow({ cwid: "bob", role: "Co-I", scholar: SCHOLAR_B }),
    ])!;
    expect(doc.wcmInvestigatorCwids).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
    expect(doc.wcmInvestigatorCwids).toHaveLength(2);
  });

  it("returns Co-I in roles when only Co-I rows exist (no PI on the project)", () => {
    const doc = projectFromRows([
      makeRow({ cwid: "carol", role: "Co-I", scholar: SCHOLAR_C }),
    ])!;
    expect(doc.roles).toEqual(["Co-I"]);
    expect(doc.isMultiPi).toBe(false);
    expect(doc.department).toBeNull(); // department comes from lead PI; no PI here
  });

  // Regression — InfoEd often emits two Account_Numbers for the same scholar
  // on one project (Equipment supplement + main Grant, renewals, etc.).
  // Both rows share coreProjectNum and group together upstream. Without
  // dedupe, the chip list duplicates the person, isMultiPi turns true on a
  // single-PI grant, and the search row's hover tooltip breaks because
  // React sees duplicate keys.
  it("dedupes a scholar with multiple Account_Numbers into one chip", () => {
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-001-alice",
        programType: "Grant",
      }),
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-002-alice",
        programType: "Equipment",
      }),
    ])!;
    expect(doc.totalPeople).toBe(1);
    expect(doc.people).toHaveLength(1);
    expect(doc.people[0].cwid).toBe("alice");
    expect(doc.isMultiPi).toBe(false);
    expect(doc.roles).toEqual(["PI"]);
    expect(doc.wcmInvestigatorCwids).toEqual(["alice"]);
  });

  it("keeps the highest-priority role when one scholar has different roles across rows", () => {
    // Pathological but possible: same scholar listed PI on one Account_Number
    // and Co-I on another. Pick the most senior role for chip display.
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "Co-I",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-001-alice",
      }),
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-002-alice",
      }),
    ])!;
    expect(doc.people).toHaveLength(1);
    expect(doc.people[0].role).toBe("PI");
  });

  it("does not flag Multi-PI when the only PI rows are duplicates of one scholar", () => {
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-001-alice",
      }),
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-002-alice",
      }),
    ])!;
    expect(doc.isMultiPi).toBe(false);
    expect(doc.roles).not.toContain("Multi-PI");
  });

  it("still flags Multi-PI when ≥2 distinct scholars have PI role across renewal rows", () => {
    // Distinguish "two account numbers, one PI each" (genuine multi-PI) from
    // "one PI with two account numbers" (false multi-PI fixed above).
    const doc = projectFromRows([
      makeRow({
        cwid: "alice",
        role: "PI",
        scholar: SCHOLAR_A,
        externalId: "INFOED-ACC-001-alice",
      }),
      makeRow({
        cwid: "bob",
        role: "PI",
        scholar: SCHOLAR_B,
        externalId: "INFOED-ACC-002-bob",
      }),
    ])!;
    expect(doc.isMultiPi).toBe(true);
    expect(doc.roles).toContain("Multi-PI");
  });
});
