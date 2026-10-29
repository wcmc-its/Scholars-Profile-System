/**
 * Center publication attribution (`lib/edit/center-pub-attribution.ts`), the
 * period-reporting rules shared by reports 18 and 19:
 *   - members are those active on the as-of date, of the chosen type;
 *   - the program credited is the one on the as-of date;
 *   - a publication counts only inside the member's WCM tenure (in / before /
 *     after), and an unknown tenure is included and counted;
 *   - the period test uses dateAddedToEntrez, else 1 January of the year;
 *   - review and relevance ride along per publication.
 * Synthetic cwids and names only.
 */
import { describe, expect, it } from "vitest";

import {
  attributeCenterPublications,
  publicationDate,
  wcmTenure,
  type AttributionMembership,
  type AttributionPublication,
  type TenureAppointment,
} from "@/lib/edit/center-pub-attribution";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

const member = (
  cwid: string,
  over: Partial<AttributionMembership> = {},
): AttributionMembership => ({
  cwid,
  programCode: "AA",
  membershipType: "research",
  startDate: d("2020-01-01"),
  endDate: null,
  membershipRoleKey: null,
  ...over,
});

const appt = (
  cwid: string,
  source: string,
  start: string | null,
  end: string | null = null,
): TenureAppointment => ({
  cwid,
  source,
  startDate: start ? d(start) : null,
  endDate: end ? d(end) : null,
});

const pub = (
  pmid: string,
  date: string | null,
  cwids: string[],
  over: Partial<AttributionPublication> = {},
): AttributionPublication => ({
  pmid,
  title: `Synthetic ${pmid}`,
  journal: null,
  year: date ? Number(date.slice(0, 4)) : null,
  dateAddedToEntrez: date ? d(date) : null,
  publicationType: "Academic Article",
  authors: cwids.map((c) => ({ cwid: c, name: `Person ${c}` })),
  ...over,
});

const run = (over: Partial<Parameters<typeof attributeCenterPublications>[0]>) =>
  attributeCenterPublications({
    memberships: [],
    membershipType: "research",
    asOf: "2026-10-29",
    from: "2025-01-01",
    to: "2025-12-31",
    appointments: [],
    publications: [],
    relevance: new Map(),
    ...over,
  });

describe("wcmTenure", () => {
  it("starts at the earliest ED or ED-HISTORICAL start and stays open while an ED row exists", () => {
    expect(
      wcmTenure([
        appt("x1", "ED", "2018-07-01", "2027-06-30"),
        appt("x1", "ED-HISTORICAL", "2012-07-01", "2018-06-30"),
      ]),
    ).toEqual({ start: "2012-07-01", end: null });
  });

  it("ends at the latest historical end when no ED row remains", () => {
    expect(
      wcmTenure([
        appt("x1", "ED-HISTORICAL", "2012-07-01", "2016-06-30"),
        appt("x1", "ED-HISTORICAL", "2016-07-01", "2024-03-31"),
      ]),
    ).toEqual({ start: "2012-07-01", end: "2024-03-31" });
  });

  it("ignores NYP and Jenzabar rows, and is unknown with no dated WCM row", () => {
    expect(
      wcmTenure([appt("x1", "ED-NYP", null), appt("x1", "JENZABAR-GSFACULTY", "2001-01-01")]),
    ).toBeNull();
    expect(wcmTenure([appt("x1", "ED", null)])).toBeNull();
    expect(wcmTenure([])).toBeNull();
  });
});

describe("publicationDate", () => {
  it("uses dateAddedToEntrez, else 1 January of the year", () => {
    expect(publicationDate({ dateAddedToEntrez: d("2025-05-06"), year: 2024 })).toBe("2025-05-06");
    expect(publicationDate({ dateAddedToEntrez: null, year: 2025 })).toBe("2025-01-01");
    expect(publicationDate({ dateAddedToEntrez: null, year: null })).toBeNull();
  });
});

describe("attributeCenterPublications", () => {
  it("credits only members active on the as-of date, of the chosen type", () => {
    const r = run({
      memberships: [
        member("cur"),
        member("gone", { endDate: d("2026-06-30") }),
        member("future", { startDate: d("2027-01-01") }),
        member("clin", { membershipType: "clinical" }),
        member("inv", { membershipRoleKey: "invited" }),
      ],
      appointments: ["cur", "gone", "future", "clin", "inv"].map((c) =>
        appt(c, "ED", "2010-01-01"),
      ),
      publications: [pub("1", "2025-03-01", ["cur", "gone", "future", "clin", "inv"])],
    });
    expect(r.memberCount).toBe(1);
    expect(r.publications[0].members.map((m) => m.cwid)).toEqual(["cur"]);
  });

  it("uses the as-of date: a member who left before it is out, one active on it is in", () => {
    const memberships = [member("m1", { endDate: d("2026-06-30") })];
    const appointments = [appt("m1", "ED", "2010-01-01")];
    const publications = [pub("1", "2025-03-01", ["m1"])];
    expect(run({ memberships, appointments, publications }).publications).toHaveLength(0);
    expect(
      run({ memberships, appointments, publications, asOf: "2026-01-15" }).publications,
    ).toHaveLength(1);
  });

  it("credits the program held on the as-of date, even for a publication from before MCC start", () => {
    const r = run({
      memberships: [member("m1", { programCode: "BB", startDate: d("2025-09-01") })],
      appointments: [appt("m1", "ED", "2015-01-01")],
      publications: [pub("1", "2025-02-01", ["m1"])],
    });
    expect(r.publications[0].members).toEqual([
      { cwid: "m1", name: "Person m1", programCode: "BB", tenureUnknown: false },
    ]);
  });

  it("counts a publication only inside the member's WCM tenure", () => {
    const r = run({
      from: "2020-01-01",
      to: "2026-12-31",
      memberships: [member("arr"), member("left")],
      appointments: [
        appt("arr", "ED", "2023-07-01"),
        appt("left", "ED-HISTORICAL", "2010-01-01", "2024-06-30"),
      ],
      publications: [
        pub("before-arrival", "2023-06-30", ["arr"]),
        pub("on-arrival", "2023-07-01", ["arr"]),
        pub("while-there", "2024-06-30", ["left"]),
        pub("after-leaving", "2024-07-01", ["left"]),
        pub("both-one-in", "2024-01-01", ["arr", "left"]),
      ],
    });
    const got = Object.fromEntries(
      r.publications.map((p) => [p.pmid, p.members.map((m) => m.cwid)]),
    );
    expect(got).toEqual({
      "on-arrival": ["arr"],
      "while-there": ["left"],
      "both-one-in": ["arr", "left"],
    });
  });

  it("includes an unknown-tenure member's publications and counts them", () => {
    const r = run({
      memberships: [member("known"), member("unk")],
      appointments: [appt("known", "ED", "2010-01-01"), appt("unk", "ED-NYP", null)],
      publications: [
        pub("1", "2025-03-01", ["unk"]),
        pub("2", "2025-03-01", ["unk", "known"]),
        pub("3", "2025-03-01", ["known"]),
      ],
    });
    expect(r.unknownTenureMembers).toBe(1);
    expect(r.unknownTenurePublications).toBe(1);
    expect(r.publications.find((p) => p.pmid === "2")?.members).toEqual([
      { cwid: "unk", name: "Person unk", programCode: "AA", tenureUnknown: true },
      { cwid: "known", name: "Person known", programCode: "AA", tenureUnknown: false },
    ]);
  });

  it("tests the period on the publication date, falling back to 1 January of the year", () => {
    const r = run({
      memberships: [member("m1")],
      appointments: [appt("m1", "ED", "2010-01-01")],
      publications: [
        pub("in", "2025-12-31", ["m1"]),
        pub("out", "2026-01-01", ["m1"]),
        pub("year-only", null, ["m1"], { year: 2025 }),
        pub("year-only-out", null, ["m1"], { year: 2024 }),
      ],
    });
    expect(r.publications.map((p) => [p.pmid, p.date])).toEqual([
      ["in", "2025-12-31"],
      ["year-only", "2025-01-01"],
    ]);
  });

  it("carries the review marker and the relevance decision", () => {
    const r = run({
      memberships: [member("m1")],
      appointments: [appt("m1", "ED", "2010-01-01")],
      publications: [
        pub("rev", "2025-03-01", ["m1"], { publicationType: "Review" }),
        pub("art", "2025-03-01", ["m1"]),
      ],
      relevance: new Map([["rev", { relevant: true, source: "llm" }]]),
    });
    expect(r.publications.map((p) => [p.pmid, p.isReview, p.relevant, p.relevanceSource])).toEqual([
      ["rev", true, true, "llm"],
      ["art", false, null, null],
    ]);
  });
});
