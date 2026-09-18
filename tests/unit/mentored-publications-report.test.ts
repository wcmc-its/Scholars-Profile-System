/**
 * `lib/edit/mentored-publications-report.ts` unit tests — fake `@/lib/db` at
 * the module boundary (the same idiom as
 * `cancer-center-publications-report.test.ts`), no live DB:
 *   - `aocMentee.findMany`                (learners × mentors × programs)
 *   - `menteeCopublicationPub.findMany`   (the bridge's (mentor, mentee, pmid) rows)
 *   - `publication.findMany`             (dateAdded / journalAbbrev / iCite)
 *   - `journalImpactFactor.findMany`     (JIF by normalized abbreviation)
 *   - `scholar.findMany`                 (mentor display names)
 *   - `aocMenteePublication.findMany/findFirst` (the learner's full list, "all" mode)
 *
 * Behaviors protected: the window rule incl. the `gradYear - 4` fallback and
 * the tail; a pub shared with two mentors counts ONCE in the learner's
 * summary; scope filtering by program bucket; the gradYears filter; the
 * learner's author position derived from the bridge's per-author CWIDs;
 * citations from iCite (`citedByCount`), never the Scopus count in the JSON;
 * mentor name precedence scholar → roster → cwid; newest class first; the
 * per-pmid Publications view deduped across learners; "all" mode's subset /
 * `withMentor` flag and the empty-bridge signal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  mockAocFindMany: vi.fn(),
  mockCopubFindMany: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockJifFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockLearnerPubFindMany: vi.fn(),
  mockLearnerPubFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      aocMentee: { findMany: hoisted.mockAocFindMany },
      menteeCopublicationPub: { findMany: hoisted.mockCopubFindMany },
      publication: { findMany: hoisted.mockPubFindMany },
      journalImpactFactor: { findMany: hoisted.mockJifFindMany },
      scholar: { findMany: hoisted.mockScholarFindMany },
      aocMenteePublication: {
        findMany: hoisted.mockLearnerPubFindMany,
        findFirst: hoisted.mockLearnerPubFindFirst,
      },
    },
    write: {},
  },
  prisma: {},
}));
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({ HIGH_IMPACT_THRESHOLD: 10 }));

import {
  defaultMentoredPubsYears,
  effectiveEntryYear,
  inProgramWindow,
  loadMentoredGradYears,
  loadMentoredPublicationsReport,
} from "@/lib/edit/mentored-publications-report";

type Aoc = {
  mentorCwid: string;
  menteeCwid: string;
  firstName: string | null;
  lastName: string | null;
  graduationYear: number | null;
  entryYear: number | null;
  programType: string | null;
  mentorFirstName: string | null;
  mentorLastName: string | null;
};

const aoc = (o: Partial<Aoc> & Pick<Aoc, "mentorCwid" | "menteeCwid">): Aoc => ({
  firstName: "Ada",
  lastName: "Learner",
  graduationYear: 2025,
  entryYear: null,
  programType: "AOC",
  mentorFirstName: null,
  mentorLastName: null,
  ...o,
});

/** An `aoc_mentee_publication` row (the learner's full list, "all" mode). */
function learnerPub(
  menteeCwid: string,
  pmid: number,
  year: number | null,
  opts: { position?: number | null } = {},
) {
  const { pub } = copub("nobody", menteeCwid, pmid, year, opts);
  return { menteeCwid, pmid, pub };
}

/** A bridge row whose `pub` JSON carries the learner at `position` on the byline. */
function copub(
  mentorCwid: string,
  menteeCwid: string,
  pmid: number,
  year: number | null,
  opts: { position?: number | null; journal?: string; scopus?: number } = {},
) {
  const position = opts.position === undefined ? 2 : opts.position;
  const authors = [
    { rank: 1, lastName: "First", firstName: null, personIdentifier: position === 1 ? menteeCwid : "zzz9999" },
    { rank: 2, lastName: "Second", firstName: null, personIdentifier: position === 2 ? menteeCwid : null },
    { rank: 3, lastName: "Mentor", firstName: null, personIdentifier: mentorCwid },
  ];
  return {
    mentorCwid,
    menteeCwid,
    pmid,
    pub: {
      pmid,
      title: `Paper ${pmid}`,
      journal: opts.journal ?? "Journal of Tests",
      year,
      doi: null,
      pmcid: null,
      volume: null,
      issue: null,
      pages: null,
      citationCount: opts.scopus ?? 999,
      abstract: null,
      authors,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.mockAocFindMany.mockResolvedValue([]);
  hoisted.mockCopubFindMany.mockResolvedValue([]);
  hoisted.mockPubFindMany.mockResolvedValue([]);
  hoisted.mockJifFindMany.mockResolvedValue([]);
  hoisted.mockScholarFindMany.mockResolvedValue([]);
  hoisted.mockLearnerPubFindMany.mockResolvedValue([]);
  hoisted.mockLearnerPubFindFirst.mockResolvedValue(null);
});

describe("window rule", () => {
  it("entryYear <= year <= gradYear + tail; unknown pub year never counts; unknown window is null", () => {
    expect(inProgramWindow(2022, 2021, 2025, 1)).toBe(true);
    expect(inProgramWindow(2026, 2021, 2025, 1)).toBe(true);
    expect(inProgramWindow(2027, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(2027, 2021, 2025, 2)).toBe(true);
    expect(inProgramWindow(2020, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(null, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(2022, null, 2025, 1)).toBeNull();
    expect(inProgramWindow(2022, 2021, null, 1)).toBeNull();
    expect(inProgramWindow(null, null, null, 1)).toBeNull();
  });

  it("effectiveEntryYear: bridge value wins, else gradYear - 4, else null", () => {
    expect(effectiveEntryYear(2020, 2025)).toEqual({ entryYear: 2020, source: "bridge" });
    expect(effectiveEntryYear(null, 2025)).toEqual({ entryYear: 2021, source: "fallback" });
    expect(effectiveEntryYear(null, null)).toEqual({ entryYear: null, source: null });
  });
});

describe("loadMentoredPublicationsReport", () => {
  it("returns an empty report and never reads the bridge when no learner is in scope", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "ECR" })]);
    const report = await loadMentoredPublicationsReport({ scopes: ["md"] });
    expect(report.summary).toEqual([]);
    expect(report.detail).toEqual([]);
    expect(report.publications).toEqual([]);
    expect(report.allPubsLoaded).toBeNull();
    expect(hoisted.mockCopubFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockLearnerPubFindFirst).not.toHaveBeenCalled();
  });

  it("applies the gradYear - 4 fallback and the tail, listing out-of-window pubs but not counting them", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: null }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2020), // before the 2021 fallback entry
      copub("men0001", "stu0001", 2, 2021), // entry year
      copub("men0001", "stu0001", 3, 2026), // grad + 1 (default tail)
      copub("men0001", "stu0001", 4, 2027), // past the tail
      copub("men0001", "stu0001", 5, null), // unknown year
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.summary).toHaveLength(1);
    const s = report.summary[0];
    expect(s).toMatchObject({
      cwid: "stu0001",
      gradYear: 2025,
      entryYear: 2021,
      entryYearSource: "fallback",
      pubsInWindow: 2,
      pubsAllTime: 5,
    });
    expect(report.detail.map((d) => [d.pmid, d.inWindow])).toEqual([
      [4, false],
      [3, true],
      [2, true],
      [1, false],
      [5, false],
    ]);

    const wider = await loadMentoredPublicationsReport({ scopes: ["*"], tail: 2 });
    expect(wider.summary[0].pubsInWindow).toBe(3);
    const noTail = await loadMentoredPublicationsReport({ scopes: ["*"], tail: 0 });
    expect(noTail.summary[0].pubsInWindow).toBe(1);
  });

  it("uses the bridge's entryYear when present", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2019 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2019)]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.summary[0]).toMatchObject({ entryYear: 2019, entryYearSource: "bridge", pubsInWindow: 1 });
  });

  it("a pub shared with two mentors is two detail rows but ONE in every summary count", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2021 }),
      aoc({ mentorCwid: "men0002", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2021 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 7, 2023, { position: 1 }),
      copub("men0002", "stu0001", 7, 2023, { position: 1 }),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "7", journalAbbrev: "N Engl J Med", dateAddedToEntrez: new Date("2023-05-01"), citedByCount: 12 },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([{ journalAbbrev: "N ENGL J MED", impactScore1: "96.2" }]);
    hoisted.mockScholarFindMany.mockResolvedValue([{ cwid: "men0001", preferredName: "Zed Mentor" }]);

    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0]).toMatchObject({
      pubsInWindow: 1,
      withMentorInWindow: 1,
      pubsAllTime: 1,
      highImpactInWindow: 1,
      firstAuthorInWindow: 1,
      // Resolved name for the scholar row; the bare cwid for the unresolved one; sorted by name.
      mentors: [
        { cwid: "men0002", name: "men0002" },
        { cwid: "men0001", name: "Zed Mentor" },
      ],
    });
    expect(report.detail).toHaveLength(2);
    expect(report.detail.map((d) => d.mentorCwid)).toEqual(["men0001", "men0002"]);
    expect(report.detail[0]).toMatchObject({
      pmid: 7,
      jif: 96.2,
      citations: 12, // iCite, NOT the Scopus 999 in the bridge JSON
      learnerAuthorPosition: 1,
      authorCount: 3,
      mentorName: "Zed Mentor",
      paperMentors: [
        { cwid: "men0002", name: "men0002" },
        { cwid: "men0001", name: "Zed Mentor" },
      ],
      withMentor: true,
      inWindow: true,
    });
    expect(report.detail[0].dateAdded?.toISOString().slice(0, 10)).toBe("2023-05-01");
    // The Publications view: ONE row for the pmid, both mentors, the learner once.
    expect(report.publications).toHaveLength(1);
    expect(report.publications[0]).toMatchObject({
      pmid: 7,
      jif: 96.2,
      citations: 12,
      withMentor: true,
      learners: [{ cwid: "stu0001", firstAuthor: true, inWindow: true }],
      mentors: [
        { cwid: "men0002", name: "men0002" },
        { cwid: "men0001", name: "Zed Mentor" },
      ],
    });
    expect(report.publications[0].citation).toBe(
      "First, Second, Mentor. Paper 7. Journal of Tests. 2023.",
    );
    // The JIF join was scoped to the abbreviations actually needed, normalized.
    expect(hoisted.mockJifFindMany).toHaveBeenCalledWith({
      where: { journalAbbrev: { in: ["N ENGL J MED"] } },
      select: { journalAbbrev: true, impactScore1: true },
    });
  });

  it("an unmatched journal / missing local row reads null JIF, null citations, no high-impact credit", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2021 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 8, 2024, { position: null })]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.detail[0]).toMatchObject({
      jif: null,
      citations: null,
      dateAdded: null,
      learnerAuthorPosition: null,
      inWindow: true,
    });
    expect(report.summary[0]).toMatchObject({ pubsInWindow: 1, highImpactInWindow: 0, firstAuthorInWindow: 0 });
  });

  it("scope filtering keeps only rows whose program bucket is admitted", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "AOC-2025" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", programType: "MDPHD" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", programType: "ECR" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0004", programType: "SOMETHING_ELSE" }),
    ]);
    const md = await loadMentoredPublicationsReport({ scopes: ["md"] });
    expect(md.summary.map((s) => [s.cwid, s.program])).toEqual([["stu0001", "MD"]]);
    // Only the admitted pair reached the bridge query.
    expect(hoisted.mockCopubFindMany).toHaveBeenCalledWith({
      where: { OR: [{ mentorCwid: "men0001", menteeCwid: "stu0001" }] },
      select: { mentorCwid: true, menteeCwid: true, pmid: true, pub: true },
    });

    const two = await loadMentoredPublicationsReport({ scopes: ["mdphd", "ecr"] });
    expect(two.summary.map((s) => s.cwid).sort()).toEqual(["stu0002", "stu0003"]);

    // "*" admits every bucket but never an unbucketable programType.
    const all = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(all.summary.map((s) => s.cwid).sort()).toEqual(["stu0001", "stu0002", "stu0003"]);
  });

  it("gradYears narrows the aoc_mentee read and the filters echo it", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"], gradYears: [2024, 2025] });
    expect(hoisted.mockAocFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { graduationYear: { in: [2024, 2025] } } }),
    );
    expect(report.filters).toEqual({
      scopes: ["*"],
      gradYears: [2024, 2025],
      tail: 1,
      pubs: "mentored",
    });

    await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(hoisted.mockAocFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: undefined }));

    // A null in the list admits the rows with no graduation year.
    await loadMentoredPublicationsReport({ scopes: ["*"], gradYears: [2025, null] });
    expect(hoisted.mockAocFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { OR: [{ graduationYear: { in: [2025] } }, { graduationYear: null }] },
      }),
    );
  });

  it("a learner with no grad year and no entry year has NO window: in-window counts null, all-time still counted", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: null, entryYear: null, programType: "MDPHD" }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2023, { position: 1 }),
      copub("men0001", "stu0001", 2, 2024),
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"], gradYears: [null] });
    expect(report.summary[0]).toMatchObject({
      gradYear: null,
      entryYear: null,
      entryYearSource: null,
      pubsInWindow: null,
      withMentorInWindow: null,
      highImpactInWindow: null,
      firstAuthorInWindow: null,
      pubsAllTime: 2,
    });
    expect(report.detail.map((d) => d.inWindow)).toEqual([null, null]);
    expect(report.publications[0].learners[0].inWindow).toBeNull();
  });

  it("sorts summary by gradYear DESC, then lastName, firstName; detail the same then year desc", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", lastName: "Baker", firstName: "Bo", graduationYear: 2024 }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", lastName: "Baker", firstName: "Al", graduationYear: 2024 }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", lastName: "Adams", firstName: "Cy", graduationYear: 2025 }),
      aoc({
        mentorCwid: "men0001",
        menteeCwid: "stu0004",
        lastName: "Zed",
        firstName: "Zo",
        graduationYear: null,
      }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2021),
      copub("men0001", "stu0001", 2, 2023),
      copub("men0001", "stu0003", 3, 2022),
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    // Newest graduating class first; unknown year last.
    expect(report.summary.map((s) => s.cwid)).toEqual(["stu0003", "stu0001", "stu0002", "stu0004"]);
    expect(report.detail.map((d) => [d.learnerCwid, d.pmid])).toEqual([
      ["stu0003", 3],
      ["stu0001", 2],
      ["stu0001", 1],
    ]);
  });

  it("mentor display name: Scholar.preferredName, else the roster's First Last, else the cwid — cwid always exposed", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({
        mentorCwid: "men0001",
        menteeCwid: "stu0001",
        mentorFirstName: "Roster",
        mentorLastName: "Name",
      }),
      aoc({
        mentorCwid: "men0002",
        menteeCwid: "stu0001",
        mentorFirstName: "Only",
        mentorLastName: "Roster",
      }),
      aoc({
        mentorCwid: "men0003",
        menteeCwid: "stu0001",
        mentorFirstName: " ",
        mentorLastName: null,
      }),
      // The same mentor again with no roster name: the first row that has one wins.
      aoc({ mentorCwid: "men0002", menteeCwid: "stu0001", programType: "AOC-2025" }),
    ]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "men0001", preferredName: "Scholar Name" },
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0003", "stu0001", 1, 2023)]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.summary[0].mentors).toEqual([
      { cwid: "men0003", name: "men0003" },
      { cwid: "men0002", name: "Only Roster" },
      { cwid: "men0001", name: "Scholar Name" },
    ]);
    expect(report.detail[0]).toMatchObject({ mentorCwid: "men0003", mentorName: "men0003" });
  });

  it("Publications view: a pub co-authored by two learners is ONE row listing both, newest first then title", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({
        mentorCwid: "men0001",
        menteeCwid: "stu0001",
        lastName: "Adams",
        graduationYear: 2025,
        entryYear: 2021,
      }),
      aoc({
        mentorCwid: "men0002",
        menteeCwid: "stu0002",
        lastName: "Baker",
        graduationYear: 2019,
        entryYear: 2015,
      }),
    ]);
    const shared1 = copub("men0001", "stu0001", 5, 2023, { position: 1 });
    const shared2 = copub("men0002", "stu0002", 5, 2023, { position: null });
    hoisted.mockCopubFindMany.mockResolvedValue([
      shared1,
      shared2,
      {
        ...copub("men0001", "stu0001", 6, 2023),
        pub: { ...copub("men0001", "stu0001", 6, 2023).pub, title: "Alpha" },
      },
      copub("men0002", "stu0002", 4, 2024),
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.publications.map((p) => p.pmid)).toEqual([4, 6, 5]);
    const shared = report.publications.find((p) => p.pmid === 5)!;
    expect(shared.learners).toEqual([
      { cwid: "stu0001", firstName: "Ada", lastName: "Adams", firstAuthor: true, inWindow: true },
      { cwid: "stu0002", firstName: "Ada", lastName: "Baker", firstAuthor: false, inWindow: false },
    ]);
    expect(shared.mentors.map((m) => m.cwid)).toEqual(["men0001", "men0002"]);
    // The detail sheet still has one row per (learner, mentor, pub).
    expect(report.detail.filter((d) => d.pmid === 5)).toHaveLength(2);
  });

  describe("pubs: 'all'", () => {
    it("reads the learner's full list, marks the mentored subset, and counts both", async () => {
      hoisted.mockAocFindMany.mockResolvedValue([
        aoc({
          mentorCwid: "men0001",
          menteeCwid: "stu0001",
          graduationYear: 2025,
          entryYear: 2021,
        }),
      ]);
      hoisted.mockCopubFindMany.mockResolvedValue([
        copub("men0001", "stu0001", 1, 2023, { position: 1 }),
      ]);
      hoisted.mockLearnerPubFindFirst.mockResolvedValue({ pmid: 1 });
      hoisted.mockLearnerPubFindMany.mockResolvedValue([
        learnerPub("stu0001", 1, 2023, { position: 1 }), // the mentored one
        learnerPub("stu0001", 2, 2024, { position: 1 }), // solo, in window
        learnerPub("stu0001", 3, 2015), // solo, before entry
      ]);
      hoisted.mockScholarFindMany.mockResolvedValue([
        { cwid: "men0001", preferredName: "Zed Mentor" },
      ]);

      const report = await loadMentoredPublicationsReport({ scopes: ["*"], pubs: "all" });
      expect(report.filters.pubs).toBe("all");
      expect(report.allPubsLoaded).toBe(true);
      expect(hoisted.mockLearnerPubFindMany).toHaveBeenCalledWith({
        where: { menteeCwid: { in: ["stu0001"] } },
        select: { menteeCwid: true, pmid: true, pub: true },
      });
      expect(report.summary[0]).toMatchObject({
        pubsInWindow: 2,
        withMentorInWindow: 1,
        firstAuthorInWindow: 2,
        pubsAllTime: 3,
      });
      // One row per (learner, pub): mentor pair columns null, paperMentors carries the mentor(s).
      expect(
        report.detail.map((d) => [
          d.pmid,
          d.mentorCwid,
          d.withMentor,
          d.paperMentors.map((m) => m.name),
        ]),
      ).toEqual([
        [2, null, false, []],
        [1, null, true, ["Zed Mentor"]],
        [3, null, false, []],
      ]);
      expect(report.publications.map((p) => [p.pmid, p.withMentor])).toEqual([
        [2, false],
        [1, true],
        [3, false],
      ]);
    });

    it("a mentored mode report never touches the learner-pubs bridge", async () => {
      hoisted.mockAocFindMany.mockResolvedValue([
        aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" }),
      ]);
      hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2023)]);
      const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
      expect(report.allPubsLoaded).toBeNull();
      expect(report.summary[0]).toMatchObject({ pubsInWindow: 1, withMentorInWindow: 1 });
      expect(hoisted.mockLearnerPubFindMany).not.toHaveBeenCalled();
      expect(hoisted.mockLearnerPubFindFirst).not.toHaveBeenCalled();
    });

    it("an EMPTY bridge table signals allPubsLoaded: false (the page's notice), with zero counts", async () => {
      hoisted.mockAocFindMany.mockResolvedValue([
        aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" }),
      ]);
      hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2023)]);
      hoisted.mockLearnerPubFindFirst.mockResolvedValue(null);
      const report = await loadMentoredPublicationsReport({ scopes: ["*"], pubs: "all" });
      expect(report.allPubsLoaded).toBe(false);
      expect(report.summary[0]).toMatchObject({
        pubsInWindow: 0,
        withMentorInWindow: 0,
        pubsAllTime: 0,
      });
      expect(report.detail).toEqual([]);
      expect(report.publications).toEqual([]);
    });
  });
});

describe("loadMentoredGradYears", () => {
  it("distinct years within scope, newest first, then null when a row in scope has no year", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      { graduationYear: 2023, programType: "AOC" },
      { graduationYear: 2025, programType: "AOC" },
      { graduationYear: 2025, programType: "MDPHD" },
      { graduationYear: 2024, programType: "ECR" },
      { graduationYear: null, programType: "AOC" },
    ]);
    expect(await loadMentoredGradYears(["*"])).toEqual([2025, 2024, 2023, null]);
    expect(await loadMentoredGradYears(["md"])).toEqual([2025, 2023, null]);
    expect(await loadMentoredGradYears(["ecr"])).toEqual([2024]);
  });

  it("defaultMentoredPubsYears: the two most recent known years, plus null when offered", () => {
    expect(defaultMentoredPubsYears([2025, 2024, 2023, null])).toEqual([2025, 2024, null]);
    expect(defaultMentoredPubsYears([2024])).toEqual([2024]);
    expect(defaultMentoredPubsYears([null])).toEqual([null]);
    expect(defaultMentoredPubsYears([])).toEqual([]);
  });
});
