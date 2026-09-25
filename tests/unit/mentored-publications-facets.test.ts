/**
 * `lib/edit/mentored-publications-facets.ts` — report 7's post-load facets
 * (In window, Author position, Publication year, Mentor, Hide learners with no
 * publications) and the rail's option counts. Pure; `@/lib/db` is stubbed
 * only because the params module's imports reach it at module scope.
 *
 * Fixture (mentored set): learner A (window known) with mentors M1 and M2,
 * learner B (window unknown) with M1, learner C (no papers) with M3.
 *   p1 2024 — A first author, in window, JIF 12, both M1 and M2 on it; B
 *             middle author (window unknown), with M1
 *   p2 2019 — A last author, outside the window, JIF 2, with M2
 *   p3 2022 — B, no byline position, window unknown, with M1
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));

import {
  applyMentoredPubsFacets,
  mentoredPubsFacetOptions,
  type MentoredPubsFacets,
} from "@/lib/edit/mentored-publications-facets";
import type {
  MentoredPublicationsReport,
  MentoredPubsDetailRow,
  MentoredPubsPublicationRow,
  MentoredPubsSummaryRow,
} from "@/lib/edit/mentored-publications-report";

const MD = { program: "md", source: "roster", tier: "confirmed" } as const;
const M1 = { cwid: "men0001", name: "Mentor One", department: "Medicine", institution: "WCM" };
const M2 = { cwid: "men0002", name: "Mentor Two", department: null, institution: "MSKCC" };
const M3 = { cwid: "men0003", name: "Mentor Three" };
const NONE: MentoredPubsFacets = { window: [], position: [], pubYears: [], mentors: [], withPubs: false };
const THRESHOLD = 10;

function learnerRow(
  cwid: string,
  lastName: string,
  mentors: Array<typeof M1 | typeof M2 | typeof M3>,
  counts: Partial<MentoredPubsSummaryRow>,
): MentoredPubsSummaryRow {
  return {
    gradYear: 2025,
    entryYear: 2021,
    entryYearSource: "bridge",
    cwid,
    firstName: "Test",
    lastName,
    program: "MD",
    mentors: mentors.map((m) => ({ ...m, mentorship: MD })),
    pubsInWindow: 0,
    withMentorInWindow: 0,
    pubsAllTime: 0,
    highImpactInWindow: 0,
    firstAuthorInWindow: 0,
    ...counts,
  };
}

function row(
  learnerCwid: string,
  mentor: typeof M1 | typeof M2,
  pmid: string,
  o: Partial<MentoredPubsDetailRow>,
): MentoredPubsDetailRow {
  return {
    gradYear: 2025,
    entryYear: 2021,
    program: "MD",
    learnerCwid,
    learnerFirstName: "Test",
    learnerLastName: learnerCwid,
    mentorCwid: mentor.cwid,
    mentorName: mentor.name,
    mentorDepartment: null,
    mentorInstitution: null,
    mentorship: "MD",
    paperMentors: [mentor],
    withMentor: true,
    pmid,
    title: `Paper ${pmid}`,
    journal: "J Test",
    jif: null,
    year: null,
    dateAdded: null,
    citations: null,
    learnerAuthorPosition: null,
    authorCount: 3,
    inWindow: null,
    ...o,
  };
}

const onPub = (cwid: string, authorPosition: number | null, inWindow: boolean | null) => ({
  cwid,
  firstName: "Test",
  lastName: cwid,
  firstAuthor: authorPosition === 1,
  authorPosition,
  inWindow,
});

function pub(pmid: string, year: number, learners: ReturnType<typeof onPub>[], mentors: Array<typeof M1 | typeof M2>): MentoredPubsPublicationRow {
  return {
    pmid,
    title: `Paper ${pmid}`,
    journal: "J Test",
    year,
    citation: `Paper ${pmid}.`,
    jif: null,
    citations: null,
    dateAdded: null,
    authorCount: 3,
    learners,
    mentors: mentors.map((m) => ({ ...m, mentorships: [MD] })),
    withMentor: true,
  };
}

const REPORT: MentoredPublicationsReport = {
  summary: [
    learnerRow("stu0001", "Alpha", [M1, M2], {
      pubsInWindow: 1,
      withMentorInWindow: 1,
      pubsAllTime: 2,
      highImpactInWindow: 1,
      firstAuthorInWindow: 1,
    }),
    learnerRow("stu0002", "Beta", [M1], {
      pubsInWindow: null,
      withMentorInWindow: null,
      pubsAllTime: 2,
      highImpactInWindow: null,
      firstAuthorInWindow: null,
    }),
    learnerRow("stu0003", "Gamma", [M3], {}),
  ],
  detail: [
    row("stu0001", M1, "1", { year: 2024, inWindow: true, learnerAuthorPosition: 1, jif: 12 }),
    row("stu0001", M2, "1", { year: 2024, inWindow: true, learnerAuthorPosition: 1, jif: 12 }),
    row("stu0001", M2, "2", { year: 2019, inWindow: false, learnerAuthorPosition: 3, jif: 2 }),
    row("stu0002", M1, "1", { year: 2024, inWindow: null, learnerAuthorPosition: 2, jif: 12 }),
    row("stu0002", M1, "3", { year: 2022, inWindow: null, learnerAuthorPosition: null }),
  ],
  publications: [
    pub("1", 2024, [onPub("stu0001", 1, true), onPub("stu0002", 2, null)], [M1, M2]),
    pub("3", 2022, [onPub("stu0002", null, null)], [M1]),
    pub("2", 2019, [onPub("stu0001", 3, false)], [M2]),
  ],
  generatedAt: new Date("2026-09-24T00:00:00Z"),
  filters: { scopes: ["*"], types: ["aoc"], gradYears: null, tail: 1, pubs: "mentored" },
  allPubsLoaded: null,
  droppedUnresolved: 0,
  droppedNoCwid: 0,
  droppedNoCwidMentees: [],
};

const counts = (r: MentoredPubsSummaryRow) => [
  r.pubsInWindow,
  r.withMentorInWindow,
  r.pubsAllTime,
  r.highImpactInWindow,
  r.firstAuthorInWindow,
];

describe("applyMentoredPubsFacets", () => {
  it("no facet set → the SAME report object (an old link reads exactly as before)", () => {
    expect(applyMentoredPubsFacets(REPORT, NONE, THRESHOLD)).toBe(REPORT);
  });

  it("In window: yes keeps only in-window (learner, publication) pairs and recounts; an unknown window stays null", () => {
    const out = applyMentoredPubsFacets(REPORT, { ...NONE, window: ["yes"] }, THRESHOLD);
    expect(out.summary.map((r) => [r.cwid, ...counts(r)])).toEqual([
      ["stu0001", 1, 1, 1, 1, 1],
      ["stu0002", null, null, 0, null, null],
      ["stu0003", 0, 0, 0, 0, 0],
    ]);
    // p1 stays, listing only the learner whose pair survived.
    expect(out.publications.map((p) => [p.pmid, p.learners.map((l) => l.cwid)])).toEqual([["1", ["stu0001"]]]);
    expect(out.detail.map((d) => `${d.learnerCwid}/${d.pmid}/${d.mentorCwid}`)).toEqual([
      "stu0001/1/men0001",
      "stu0001/1/men0002",
    ]);
    expect(out.facets).toEqual({ window: ["yes"], position: [], pubYears: [], mentors: [], withPubs: false });
  });

  it("Author position: a pair with no byline position never matches; last = the final byline rank", () => {
    const first = applyMentoredPubsFacets(REPORT, { ...NONE, position: ["first"] }, THRESHOLD);
    expect(first.publications.map((p) => p.pmid)).toEqual(["1"]);
    expect(first.summary.find((r) => r.cwid === "stu0002")?.pubsAllTime).toBe(0);
    const last = applyMentoredPubsFacets(REPORT, { ...NONE, position: ["last"] }, THRESHOLD);
    expect(last.publications.map((p) => p.pmid)).toEqual(["2"]);
    const middle = applyMentoredPubsFacets(REPORT, { ...NONE, position: ["middle"] }, THRESHOLD);
    expect(middle.publications.map((p) => [p.pmid, p.learners.map((l) => l.cwid)])).toEqual([["1", ["stu0002"]]]);
  });

  it("Publication year keeps the papers of those years", () => {
    const out = applyMentoredPubsFacets(REPORT, { ...NONE, pubYears: [2019, 2022] }, THRESHOLD);
    expect(out.publications.map((p) => p.pmid)).toEqual(["3", "2"]);
    expect(out.summary.map((r) => r.pubsAllTime)).toEqual([1, 1, 0]);
  });

  it("Mentor keeps the learners with that mentor, only that mentor's pairs, and names it for the workbook", () => {
    const out = applyMentoredPubsFacets(REPORT, { ...NONE, mentors: ["men0002"] }, THRESHOLD);
    expect(out.summary.map((r) => r.cwid)).toEqual(["stu0001"]);
    expect(out.summary[0].mentors.map((m) => m.cwid)).toEqual(["men0002"]);
    expect(counts(out.summary[0])).toEqual([1, 1, 2, 1, 1]);
    expect(out.detail.every((d) => d.mentorCwid === "men0002")).toBe(true);
    // p1 lists M2 only; B (whose pair was with M1) is gone from it.
    expect(out.publications.map((p) => [p.pmid, p.learners.map((l) => l.cwid), p.mentors.map((m) => m.cwid)])).toEqual([
      ["1", ["stu0001"], ["men0002"]],
      ["2", ["stu0001"], ["men0002"]],
    ]);
    expect(out.facets?.mentors).toEqual([{ cwid: "men0002", name: "Mentor Two" }]);
  });

  it("Hide learners with no publications drops them after the other facets", () => {
    const out = applyMentoredPubsFacets(REPORT, { ...NONE, withPubs: true }, THRESHOLD);
    expect(out.summary.map((r) => r.cwid)).toEqual(["stu0001", "stu0002"]);
    const narrowed = applyMentoredPubsFacets(REPORT, { ...NONE, window: ["no"], withPubs: true }, THRESHOLD);
    expect(narrowed.summary.map((r) => [r.cwid, r.pubsAllTime])).toEqual([["stu0001", 1]]);
  });

  it("the all-publications set: Mentor keeps every paper of the learner; 'with a mentor' means a selected mentor", () => {
    const all: MentoredPublicationsReport = {
      ...REPORT,
      filters: { ...REPORT.filters, pubs: "all" },
      detail: REPORT.detail
        .filter((d) => !(d.learnerCwid === "stu0001" && d.pmid === "1" && d.mentorCwid === "men0002"))
        .map((d) =>
          d.learnerCwid === "stu0001" && d.pmid === "1"
            ? { ...d, mentorCwid: null, mentorName: null, mentorship: null, paperMentors: [M1, M2] }
            : { ...d, mentorCwid: null, mentorName: null, mentorship: null },
        ),
    };
    const out = applyMentoredPubsFacets(all, { ...NONE, mentors: ["men0001"] }, THRESHOLD);
    expect(out.summary.map((r) => r.cwid)).toEqual(["stu0001", "stu0002"]);
    const a = out.summary[0];
    // p2 (with M2 only) stays — every paper of the learner — but not "with a mentor".
    expect(a.pubsAllTime).toBe(2);
    expect(out.detail.find((d) => d.learnerCwid === "stu0001" && d.pmid === "2")).toMatchObject({
      paperMentors: [],
      withMentor: false,
    });
    expect(out.detail.find((d) => d.learnerCwid === "stu0001" && d.pmid === "1")?.paperMentors).toEqual([M1]);
  });
});

describe("mentoredPubsFacetOptions", () => {
  it("counts distinct publications per value over the pairs passing every OTHER facet; fixed order; zeros listed", () => {
    const o = mentoredPubsFacetOptions(REPORT, NONE);
    expect(o.window).toEqual([
      { value: "yes", label: "In window", count: 1 },
      { value: "no", label: "Outside window", count: 1 },
      { value: "unknown", label: "Window unknown", count: 2 },
    ]);
    expect(o.position.map((x) => [x.value, x.count])).toEqual([
      ["first", 1],
      ["last", 1],
      ["middle", 1],
    ]);
    expect(o.pubYears.map((x) => [x.value, x.count])).toEqual([
      ["2024", 1],
      ["2022", 1],
      ["2019", 1],
    ]);
    // Learners per mentor, most first, then by name.
    expect(o.mentors).toEqual([
      { value: "men0001", label: "Mentor One", count: 2 },
      { value: "men0003", label: "Mentor Three", count: 1 },
      { value: "men0002", label: "Mentor Two", count: 1 },
    ]);

    // Window counts under Author position: first — the facet's own selection is ignored.
    const cross = mentoredPubsFacetOptions(REPORT, { ...NONE, position: ["first"], window: ["no"] });
    expect(cross.window.map((x) => [x.value, x.count])).toEqual([
      ["yes", 1],
      ["no", 0],
      ["unknown", 0],
    ]);
    expect(cross.position.map((x) => [x.value, x.count])).toEqual([
      ["first", 0],
      ["last", 1],
      ["middle", 0],
    ]);
  });

  it("hide-no-publications: a mentor counts only learners left with a paper; a selected unknown mentor is still listed", () => {
    const o = mentoredPubsFacetOptions(REPORT, { ...NONE, withPubs: true, mentors: ["zzz9999"] });
    expect(o.mentors).toEqual([
      { value: "men0001", label: "Mentor One", count: 2 },
      { value: "men0002", label: "Mentor Two", count: 1 },
      { value: "men0003", label: "Mentor Three", count: 0 },
      { value: "zzz9999", label: "zzz9999", count: 0 },
    ]);
  });
});
