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
 *   - `phdMentorRelationship.findMany`     (Jenzabar thesis advisors)
 *   - `postdocMentorRelationship.findMany` (ED postdoc appointments)
 *   - `menteeSuggestion.findMany`          (co-author-inferred pairs + evidence,
 *                                           and the per-pair read for faculty pairs)
 *   - `fieldOverride.findMany`             (the mentors' `manualMentees` overrides)
 *   - `publicationAuthor.findMany`         (faculty-pair co-pubs with no suggestion row)
 *
 * Behaviors protected: the window rule incl. the `gradYear - 4` fallback and
 * the tail; a pub shared with two mentors counts ONCE in the learner's
 * summary; scope filtering by program bucket; the gradYears filter; the
 * learner's author position derived from the bridge's per-author CWIDs;
 * citations from iCite (`citedByCount`), never the Scopus count in the JSON;
 * mentor name precedence scholar → roster → cwid; newest class first; the
 * per-pmid Publications view deduped across learners, most recently added to
 * PubMed first (NOT by year); "all" mode's subset / `withMentor` flag and the
 * empty-bridge signal; every (learner, mentor) pair typed `{ bucket, roster,
 * confirmed }`; the three other sources land typed, year-filtered by their
 * own year, no 4-year guess for a PhD, an ongoing postdoc's open window,
 * suggestion evidence resolved from `publication` (unresolved counted); a
 * Scopus-only key (`SCOPUS:…`, round 5) flows through the bridge and the
 * evidence alike, with JIF and null iCite citations; the `types` filter
 * (round 6) reads only the sources the selected keys need and admits only
 * selected pairs — a learner with a roster pair and co-author pairs shows
 * the roster pair alone under `["aoc"]`, and the year chips are the union
 * over the selected sources. Every pre-types test selects `ALL`. Faculty-
 * asserted pairs (`manualMentees`, PR C): typed confirmed, program from the
 * entry's `programType` or "other", ranked below roster / Jenzabar / ED and
 * above a co-author inference for the same pair; pubs from the pair's
 * suggestion row (any tier, dismissed or not) else the `publication_author`
 * intersection; CWID-less entries counted in `droppedNoCwid`.
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
  mockPhdFindMany: vi.fn(),
  mockPostdocFindMany: vi.fn(),
  mockSuggestionFindMany: vi.fn(),
  mockOverrideFindMany: vi.fn(),
  mockAuthorFindMany: vi.fn(),
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
      phdMentorRelationship: { findMany: hoisted.mockPhdFindMany },
      postdocMentorRelationship: { findMany: hoisted.mockPostdocFindMany },
      menteeSuggestion: { findMany: hoisted.mockSuggestionFindMany },
      fieldOverride: { findMany: hoisted.mockOverrideFindMany },
      publicationAuthor: { findMany: hoisted.mockAuthorFindMany },
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
  mentorInstitution,
} from "@/lib/edit/mentored-publications-report";
import { MENTORSHIP_TYPE_KEYS } from "@/lib/edit/mentorship-type";

const ALL = [...MENTORSHIP_TYPE_KEYS];

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
  mentorDepartment: string | null;
  mentorInstitution: string | null;
};

const aoc = (o: Partial<Aoc> & Pick<Aoc, "mentorCwid" | "menteeCwid">): Aoc => ({
  firstName: "Ada",
  lastName: "Learner",
  graduationYear: 2025,
  entryYear: null,
  programType: "AOC",
  mentorFirstName: null,
  mentorLastName: null,
  mentorDepartment: null,
  mentorInstitution: null,
  ...o,
});

/** An `aoc_mentee_publication` row (the learner's full list, "all" mode). */
function learnerPub(
  menteeCwid: string,
  pmid: number | string,
  year: number | null,
  opts: { position?: number | null } = {},
) {
  const { pub } = copub("nobody", menteeCwid, pmid, year, opts);
  return { menteeCwid, pmid: String(pmid), pub };
}

/** A bridge row whose `pub` JSON carries the learner at `position` on the
 *  byline. The row key is the SPS string key; a string `pmid` is a
 *  Scopus-only key, whose JSON `pmid` is ReciterDB's synthetic negative. */
function copub(
  mentorCwid: string,
  menteeCwid: string,
  pmid: number | string,
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
    pmid: String(pmid),
    pub: {
      id: String(pmid),
      pmid: typeof pmid === "number" ? pmid : -4242,
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
  hoisted.mockPhdFindMany.mockResolvedValue([]);
  hoisted.mockPostdocFindMany.mockResolvedValue([]);
  hoisted.mockSuggestionFindMany.mockResolvedValue([]);
  hoisted.mockOverrideFindMany.mockResolvedValue([]);
  hoisted.mockAuthorFindMany.mockResolvedValue([]);
});

describe("mentorInstitution", () => {
  it("folds the roster's spellings of the three tracked institutions; passes anything else through", () => {
    for (const s of ["Weill Cornell Medical College", "WCM, Cornell University", "WCM (formerly)", "Weill Cornell", "wcmc"])
      expect(mentorInstitution(s)).toBe("WCM");
    for (const s of ["Memorial Sloan Kettering Cancer Center", "Sloan-Kettering", "MSKCC", "MSK"])
      expect(mentorInstitution(s)).toBe("MSKCC");
    for (const s of ["Hospital for Special Surgery", "HSS"]) expect(mentorInstitution(s)).toBe("HSS");
    expect(mentorInstitution("Rockefeller University")).toBe("Rockefeller University");
    expect(mentorInstitution("NYP, Cornell University")).toBe("NYP, Cornell University");
    // ED primary-organization codes are named through lib/institutions.ts first.
    expect(mentorInstitution("WCMC")).toBe("WCM");
    expect(mentorInstitution("MSKCC")).toBe("MSKCC");
    expect(mentorInstitution("HSS")).toBe("HSS");
    expect(mentorInstitution("RU")).toBe("Rockefeller University");
    expect(mentorInstitution("NYP")).toBe("New York-Presbyterian Hospital");
    expect(mentorInstitution("WCMC-Q")).toBe("Weill Cornell Medical College in Qatar");
    expect(mentorInstitution("  ")).toBeNull();
    expect(mentorInstitution(null)).toBeNull();
    expect(mentorInstitution(undefined)).toBeNull();
  });
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

  it("ongoing (no end date): in window iff year >= entryYear, grad year irrelevant; no entry year → still null", () => {
    expect(inProgramWindow(2022, 2022, null, 1, true)).toBe(true);
    expect(inProgramWindow(2040, 2022, null, 1, true)).toBe(true);
    expect(inProgramWindow(2021, 2022, null, 1, true)).toBe(false);
    expect(inProgramWindow(null, 2022, null, 1, true)).toBe(false);
    expect(inProgramWindow(2022, null, null, 1, true)).toBeNull();
  });

  it("effectiveEntryYear: bridge value wins, else gradYear - 4 (roster only), else null", () => {
    expect(effectiveEntryYear(2020, 2025)).toEqual({ entryYear: 2020, source: "bridge" });
    expect(effectiveEntryYear(null, 2025)).toEqual({ entryYear: 2021, source: "fallback" });
    expect(effectiveEntryYear(null, 2025, false)).toEqual({ entryYear: null, source: null });
    expect(effectiveEntryYear(null, null)).toEqual({ entryYear: null, source: null });
  });
});

describe("loadMentoredPublicationsReport", () => {
  it("returns an empty report and never reads the bridge when no learner is in scope", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "ECR" })]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["md"] });
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
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
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
      ["4", false],
      ["3", true],
      ["2", true],
      ["1", false],
      ["5", false],
    ]);

    const wider = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"], tail: 2 });
    expect(wider.summary[0].pubsInWindow).toBe(3);
    const noTail = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"], tail: 0 });
    expect(noTail.summary[0].pubsInWindow).toBe(1);
  });

  it("uses the bridge's entryYear when present", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2019 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2019)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
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

    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0]).toMatchObject({
      pubsInWindow: 1,
      withMentorInWindow: 1,
      pubsAllTime: 1,
      highImpactInWindow: 1,
      firstAuthorInWindow: 1,
      // Resolved name for the scholar row; the bare cwid for the unresolved one; sorted by name.
      mentors: [
        { cwid: "men0002", name: "men0002", mentorship: { program: "md", source: "roster", tier: "confirmed" } },
        { cwid: "men0001", name: "Zed Mentor", mentorship: { program: "md", source: "roster", tier: "confirmed" } },
      ],
    });
    expect(report.detail).toHaveLength(2);
    expect(report.detail.map((d) => d.mentorCwid)).toEqual(["men0001", "men0002"]);
    expect(report.detail[0]).toMatchObject({
      pmid: "7",
      jif: 96.2,
      citations: 12, // iCite, NOT the Scopus 999 in the bridge JSON
      learnerAuthorPosition: 1,
      authorCount: 3,
      mentorName: "Zed Mentor",
      mentorship: "MD",
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
      pmid: "7",
      jif: 96.2,
      citations: 12,
      withMentor: true,
      learners: [{ cwid: "stu0001", firstAuthor: true, authorPosition: 1, inWindow: true }],
      mentors: [
        { cwid: "men0002", name: "men0002", mentorships: [{ program: "md", source: "roster", tier: "confirmed" }] },
        { cwid: "men0001", name: "Zed Mentor", mentorships: [{ program: "md", source: "roster", tier: "confirmed" }] },
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
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.detail[0]).toMatchObject({
      jif: null,
      citations: null,
      dateAdded: null,
      learnerAuthorPosition: null,
      inWindow: true,
    });
    expect(report.summary[0]).toMatchObject({ pubsInWindow: 1, highImpactInWindow: 0, firstAuthorInWindow: 0 });
  });

  it("a Scopus-only bridge row (SCOPUS: key) lands with JIF from its publication row and null iCite citations", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", graduationYear: 2025, entryYear: 2021 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", "SCOPUS:105037533819", 2024, { position: 1 }),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "SCOPUS:105037533819", journalAbbrev: "N Engl J Med", dateAddedToEntrez: null, citedByCount: null },
    ]);
    hoisted.mockJifFindMany.mockResolvedValue([{ journalAbbrev: "N ENGL J MED", impactScore1: "96.2" }]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(hoisted.mockPubFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pmid: { in: ["SCOPUS:105037533819"] } } }),
    );
    expect(report.detail[0]).toMatchObject({ pmid: "SCOPUS:105037533819", jif: 96.2, citations: null, dateAdded: null });
    expect(report.publications[0]).toMatchObject({ pmid: "SCOPUS:105037533819", jif: 96.2, citations: null });
    expect(report.summary[0]).toMatchObject({ pubsInWindow: 1, highImpactInWindow: 1, firstAuthorInWindow: 1 });
  });

  it("scope filtering keeps only rows whose program bucket is admitted", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "AOC-2025" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", programType: "MDPHD" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", programType: "ECR" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0004", programType: "SOMETHING_ELSE" }),
    ]);
    const md = await loadMentoredPublicationsReport({ types: ALL, scopes: ["md"] });
    expect(md.summary.map((s) => [s.cwid, s.program])).toEqual([["stu0001", "MD"]]);
    // Only the admitted pair reached the bridge query.
    expect(hoisted.mockCopubFindMany).toHaveBeenCalledWith({
      where: { OR: [{ mentorCwid: "men0001", menteeCwid: "stu0001" }] },
      select: { mentorCwid: true, menteeCwid: true, pmid: true, pub: true },
    });

    const two = await loadMentoredPublicationsReport({ types: ALL, scopes: ["mdphd", "ecr"] });
    expect(two.summary.map((s) => s.cwid).sort()).toEqual(["stu0002", "stu0003"]);

    // "*" admits every bucket but never an unbucketable programType.
    const all = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(all.summary.map((s) => s.cwid).sort()).toEqual(["stu0001", "stu0002", "stu0003"]);
  });

  it("gradYears narrows the aoc_mentee read and the filters echo it", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([]);
    const report = await loadMentoredPublicationsReport({
      types: ALL,
      scopes: ["*"],
      gradYears: [2024, 2025],
    });
    expect(hoisted.mockAocFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { graduationYear: { in: [2024, 2025] } } }),
    );
    expect(report.filters).toEqual({
      scopes: ["*"],
      types: ALL,
      gradYears: [2024, 2025],
      tail: 1,
      pubs: "mentored",
    });

    await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(hoisted.mockAocFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: undefined }));

    // A null in the list admits the rows with no graduation year.
    await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"], gradYears: [2025, null] });
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
    const report = await loadMentoredPublicationsReport({
      types: ALL,
      scopes: ["*"],
      gradYears: [null],
    });
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
      copub("men0001", "stu0001", 10, 2023), // same year as 2: the key tiebreak is lexicographic
      copub("men0001", "stu0003", 3, 2022),
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    // Newest graduating class first; unknown year last.
    expect(report.summary.map((s) => s.cwid)).toEqual(["stu0003", "stu0001", "stu0002", "stu0004"]);
    expect(report.detail.map((d) => [d.learnerCwid, d.pmid])).toEqual([
      ["stu0003", "3"],
      ["stu0001", "2"],
      ["stu0001", "10"],
      ["stu0001", "1"],
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
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary[0].mentors.map((m) => [m.cwid, m.name])).toEqual([
      ["men0003", "men0003"],
      ["men0002", "Only Roster"],
      ["men0001", "Scholar Name"],
    ]);
    expect(report.detail[0]).toMatchObject({ mentorCwid: "men0003", mentorName: "men0003" });
  });

  it("mentor department: Scholar.primaryDepartment, else the roster's; institution: the roster's folded, else WCM for a Scholar row, else null", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      // Scholar row with a department; roster says something else and names MSK → ED wins, MSKCC.
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", mentorDepartment: "Roster Dept", mentorInstitution: "Sloan-Kettering" }),
      // Scholar row with no department; roster silent → roster dept, WCM by the Scholar row.
      aoc({ mentorCwid: "men0002", menteeCwid: "stu0001", mentorDepartment: null, mentorInstitution: " " }),
      aoc({ mentorCwid: "men0002", menteeCwid: "stu0002", mentorDepartment: "Pediatrics", mentorInstitution: null }),
      // No Scholar row: roster only; an unlisted institution passes through as typed.
      aoc({ mentorCwid: "men0003", menteeCwid: "stu0001", mentorDepartment: null, mentorInstitution: "Rockerfeller Univ" }),
      aoc({ mentorCwid: "men0004", menteeCwid: "stu0001" }),
    ]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "men0001", preferredName: "A", primaryDepartment: "Medicine" },
      { cwid: "men0002", preferredName: "B", primaryDepartment: null },
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2023)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    const byCwid = new Map(report.summary[0].mentors.map((m) => [m.cwid, [m.department, m.institution]]));
    expect(byCwid.get("men0001")).toEqual(["Medicine", "MSKCC"]);
    expect(byCwid.get("men0002")).toEqual(["Pediatrics", "WCM"]);
    expect(byCwid.get("men0003")).toEqual([null, "Rockerfeller Univ"]);
    expect(byCwid.get("men0004")).toEqual([null, null]);
    expect(report.detail[0]).toMatchObject({ mentorCwid: "men0001", mentorDepartment: "Medicine", mentorInstitution: "MSKCC" });
    expect(report.publications[0].mentors[0]).toMatchObject({ cwid: "men0001", department: "Medicine", institution: "MSKCC" });
  });

  it("Publications view: a pub co-authored by two learners is ONE row listing both, most recently added to PubMed first", async () => {
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
    // dateAdded DISAGREES with year: 5 (2023) was added after 4 (2024); 6 has
    // no local row and sorts last.
    hoisted.mockPubFindMany.mockResolvedValue([
      { pmid: "5", journalAbbrev: null, dateAddedToEntrez: new Date("2024-06-01"), citedByCount: null },
      { pmid: "4", journalAbbrev: null, dateAddedToEntrez: new Date("2024-01-01"), citedByCount: null },
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.publications.map((p) => p.pmid)).toEqual(["5", "4", "6"]);
    const shared = report.publications.find((p) => p.pmid === "5")!;
    expect(shared.learners).toEqual([
      { cwid: "stu0001", firstName: "Ada", lastName: "Adams", firstAuthor: true, authorPosition: 1, inWindow: true },
      { cwid: "stu0002", firstName: "Ada", lastName: "Baker", firstAuthor: false, authorPosition: null, inWindow: false },
    ]);
    expect(shared.mentors.map((m) => m.cwid)).toEqual(["men0001", "men0002"]);
    // The detail sheet still has one row per (learner, mentor, pub).
    expect(report.detail.filter((d) => d.pmid === "5")).toHaveLength(2);
  });

  it("a mentor shared by two learners of different types lists both, deduped by key", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "AOC" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", programType: "MDPHD", graduationYear: null }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", programType: "AOC-2025" }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 9, 2024),
      copub("men0001", "stu0002", 9, 2024),
      copub("men0001", "stu0003", 9, 2024),
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.publications).toHaveLength(1);
    expect(report.publications[0].mentors).toMatchObject([
      {
        cwid: "men0001",
        name: "men0001",
        mentorships: [
          { program: "md", source: "roster", tier: "confirmed" },
          { program: "mdphd", source: "roster", tier: "confirmed" },
        ],
      },
    ]);
    expect(report.summary.map((s) => s.mentors[0].mentorship.program)).toEqual(["md", "md", "mdphd"]);
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

      const report = await loadMentoredPublicationsReport({
        types: ALL,
        scopes: ["*"],
        pubs: "all",
      });
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
        ["2", null, false, []],
        ["1", null, true, ["Zed Mentor"]],
        ["3", null, false, []],
      ]);
      expect(report.publications.map((p) => [p.pmid, p.withMentor])).toEqual([
        ["2", false],
        ["1", true],
        ["3", false],
      ]);
      expect(report.detail.every((d) => d.mentorship === null)).toBe(true);
    });

    it("a mentored mode report never touches the learner-pubs bridge", async () => {
      hoisted.mockAocFindMany.mockResolvedValue([
        aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" }),
      ]);
      hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2023)]);
      const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
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
      const report = await loadMentoredPublicationsReport({
        types: ALL,
        scopes: ["*"],
        pubs: "all",
      });
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

describe("the other pair sources (Jenzabar, ED postdoc, co-author suggestions)", () => {
  const phd = (o: Partial<Record<string, unknown>> & { mentorCwid: string; menteeCwid: string }) => ({
    menteeFirstName: "Pia",
    menteeLastName: "Doctoral",
    conferralYear: 2024,
    programType: "PhD",
    mentorFirstName: "Jen",
    mentorLastName: "Zabar",
    ...o,
  });
  const postdoc = (o: Partial<Record<string, unknown>> & { mentorCwid: string; menteeCwid: string }) => ({
    menteeFirstName: "Pat",
    menteeLastName: "Postdoc",
    startDate: new Date("2022-07-01"),
    endDate: null,
    ...o,
  });
  const suggestion = (o: Partial<Record<string, unknown>> & { mentorCwid: string; menteeCwid: string }) => ({
    menteeName: "Vic Van Volunteer",
    kind: "volunteer",
    tier: "presumptive",
    evidence: [{ id: "101", year: 2024, menteeRank: 1, mentorRank: 3, total: 3 }],
    ...o,
  });
  /** A local `publication` row as BOTH reads see it (evidence resolve + enrich). */
  const localPub = (pmid: number | string) => ({
    pmid: String(pmid),
    title: `Local ${pmid}`,
    journal: "J Local",
    year: 2024,
    volume: "5",
    issue: "2",
    pages: "10-20",
    authorsString: "((Van Volunteer V)), Second AB, ((Mentor Z))",
    fullAuthorsString: null,
    journalAbbrev: null,
    dateAddedToEntrez: null,
    citedByCount: null,
  });

  it("mentor identity falls through the sources: Jenzabar's department/institution, the ED postdoc pass's name/department/org code, Scholar.primaryOrgCode", async () => {
    hoisted.mockPhdFindMany.mockResolvedValue([
      // Thesis advisor with no Scholar row: Jenzabar's department + "Sloan-Kettering".
      phd({ mentorCwid: "men0010", menteeCwid: "phd0001", mentorDepartment: "Pharmacology", mentorInstitution: "Sloan-Kettering" }),
    ]);
    hoisted.mockPostdocFindMany.mockResolvedValue([
      // A lab administrator listed as the postdoc's manager: no Scholar row, no roster row —
      // the ED pass's ou=people lookup is the only word on them.
      postdoc({ mentorCwid: "pak0001", menteeCwid: "pd0001", mentorFirstName: "Pat", mentorLastName: "Admin", mentorDepartment: "Some Lab Research", mentorInstitution: "WCMC" }),
      // A departed manager the lookup missed: bare cwid, nothing else.
      postdoc({ mentorCwid: "gone0001", menteeCwid: "pd0002", mentorFirstName: null, mentorLastName: null, mentorDepartment: null, mentorInstitution: null }),
      // A Scholar mentor: Scholar name/department win; institution from Scholar.primaryOrgCode (HSS).
      postdoc({ mentorCwid: "men0011", menteeCwid: "pd0003", mentorFirstName: "Ed", mentorLastName: "Name", mentorDepartment: "ED dept", mentorInstitution: null }),
    ]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "men0011", preferredName: "Scholar Name", primaryDepartment: "Orthopaedic Surgery", primaryOrgCode: "HSS" },
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"], types: ["thesis", "postdoc"] });
    const byCwid = new Map(
      report.summary.flatMap((s) => s.mentors).map((m) => [m.cwid, [m.name, m.department, m.institution]]),
    );
    expect(byCwid.get("men0010")).toEqual(["Jen Zabar", "Pharmacology", "MSKCC"]);
    expect(byCwid.get("pak0001")).toEqual(["Pat Admin", "Some Lab Research", "WCM"]);
    expect(byCwid.get("gone0001")).toEqual(["gone0001", null, null]);
    expect(byCwid.get("men0011")).toEqual(["Scholar Name", "Orthopaedic Surgery", "HSS"]);
  });

  it("one learner from each source lands typed, regardless of scope; the suggestion read skips dismissed / unknown-tier rows", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" })]);
    hoisted.mockPhdFindMany.mockResolvedValue([
      phd({ mentorCwid: "men0002", menteeCwid: "phd0001" }),
      phd({ mentorCwid: "men0002", menteeCwid: "phd0002", programType: "MD-PhD", conferralYear: 2023 }),
    ]);
    hoisted.mockPostdocFindMany.mockResolvedValue([postdoc({ mentorCwid: "men0003", menteeCwid: "pd0001" })]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion({ mentorCwid: "men0004", menteeCwid: "sug0001" }),
      suggestion({ mentorCwid: "men0004", menteeCwid: "sug0002", menteeName: "Mononym", kind: "resident", tier: "ambiguous", evidence: [] }),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub(101)]);

    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["md"] });
    expect(hoisted.mockSuggestionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dismissedAt: null, tier: { in: ["presumptive", "ambiguous"] } } }),
    );
    // Newest grad year first, unknown last; the row is the learner, the type is per pair.
    expect(report.summary.map((s) => [s.cwid, s.program, s.gradYear, s.mentors[0].mentorship])).toEqual([
      ["stu0001", "MD", 2025, { program: "md", source: "roster", tier: "confirmed" }],
      ["phd0001", "PhD", 2024, { program: "phd", source: "jenzabar", tier: "confirmed" }],
      ["phd0002", "MD-PhD", 2023, { program: "mdphd", source: "jenzabar", tier: "confirmed" }],
      ["sug0002", "Resident", null, { program: "resident", source: "coauthor", tier: "ambiguous" }],
      ["pd0001", "Postdoc", null, { program: "postdoc", source: "ed", tier: "confirmed" }],
      ["sug0001", "Volunteer", null, { program: "volunteer", source: "coauthor", tier: "presumptive" }],
    ]);
    // Learner names: Jenzabar / ED first+last; a suggestion's display name split on its last space.
    expect(report.summary.map((s) => [s.firstName, s.lastName])).toEqual([
      ["Ada", "Learner"],
      ["Pia", "Doctoral"],
      ["Pia", "Doctoral"],
      [null, "Mononym"],
      ["Pat", "Postdoc"],
      ["Vic Van", "Volunteer"],
    ]);
    // Jenzabar's own mentor name reaches the roster-name map.
    expect(report.summary[1].mentors[0].name).toBe("Jen Zabar");
  });
  it("a co-author pair a surer source also claims leaves NO trace: no kind in Program, no coauthor type", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "AOC", graduationYear: 2025 }),
    ]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion({ mentorCwid: "men0001", menteeCwid: "stu0001", kind: "volunteer" }),
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0].program).toBe("MD");
    expect(report.summary[0].mentors.map((m) => m.mentorship.source)).toEqual(["roster"]);
  });

  it("a malformed evidence blob is skipped, never thrown", async () => {
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion({ mentorCwid: "men0004", menteeCwid: "sug0001", evidence: { id: "101" } }),
      suggestion({ mentorCwid: "men0004", menteeCwid: "sug0002", evidence: [null, 7, { id: 101 }, { id: "101", menteeRank: 1 }] }),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub(101)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary.map((s) => [s.cwid, s.pubsAllTime])).toEqual([
      ["sug0001", 0],
      ["sug0002", 1],
    ]);
  });

  it("a suggestion's evidence resolves from `publication`: parsed byline, authorPosition = menteeRank, mentor on the paper; a SCOPUS: id resolves too; unresolved ids are counted", async () => {
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion({
        mentorCwid: "men0004",
        menteeCwid: "sug0001",
        evidence: [
          { id: "101", year: 2024, menteeRank: 1, mentorRank: 3, total: 3 },
          { id: "SCOPUS:2-s2.0-85000000001", year: 2024, menteeRank: 1, mentorRank: 2, total: 2 },
          { id: "", year: 2024, menteeRank: 1, mentorRank: 2, total: 2 }, // no key — skipped, not counted
          { id: "102", year: 2023, menteeRank: 2, mentorRank: 1, total: 2 }, // no local row
        ],
      }),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub(101), localPub("SCOPUS:2-s2.0-85000000001")]);
    hoisted.mockScholarFindMany.mockResolvedValue([{ cwid: "men0004", preferredName: "Zed Mentor" }]);

    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.droppedUnresolved).toBe(1);
    expect(report.publications.map((p) => p.pmid)).toEqual(["101", "SCOPUS:2-s2.0-85000000001"]);
    expect(report.publications[1]).toMatchObject({ pmid: "SCOPUS:2-s2.0-85000000001", citations: null, withMentor: true });
    expect(report.publications[0]).toMatchObject({
      pmid: "101",
      title: "Local 101",
      citation: "Van Volunteer V, Second AB, Mentor Z. Local 101. J Local. 2024;5(2):10-20.",
      authorCount: 3,
      withMentor: true,
      learners: [{ cwid: "sug0001", firstAuthor: true, authorPosition: 1, inWindow: null }],
      mentors: [
        {
          cwid: "men0004",
          name: "Zed Mentor",
          mentorships: [{ program: "volunteer", source: "coauthor", tier: "presumptive" }],
        },
      ],
    });
    expect(report.detail).toHaveLength(2);
    expect(report.detail[0]).toMatchObject({
      pmid: "SCOPUS:2-s2.0-85000000001",
      mentorCwid: "men0004",
      mentorship: "Volunteer · likely mentee (from co-authorship)",
      learnerAuthorPosition: 1,
      withMentor: true,
      inWindow: null,
    });
    expect(report.summary[0]).toMatchObject({ cwid: "sug0001", pubsAllTime: 2, pubsInWindow: null, entryYearSource: null });
  });

  it("a pair the roster already confirms keeps its roster type and reads the bridge, not the suggestion's evidence", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" })]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([suggestion({ mentorCwid: "men0001", menteeCwid: "stu0001" })]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 7, 2023)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0].mentors).toMatchObject([
      { cwid: "men0001", name: "men0001", mentorship: { program: "md", source: "roster", tier: "confirmed" } },
    ]);
    expect(report.publications.map((p) => p.pmid)).toEqual(["7"]);
    expect(report.droppedUnresolved).toBe(0);
  });

  it("an ongoing postdoc's window has no upper bound: pubs from the start year on count, grad year stays null", async () => {
    hoisted.mockPostdocFindMany.mockResolvedValue([
      postdoc({ mentorCwid: "men0003", menteeCwid: "pd0001" }),
      postdoc({ mentorCwid: "men0003", menteeCwid: "pd0002", menteeLastName: "Ended", endDate: new Date("2024-06-30") }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0003", "pd0001", 1, 2021), // before the start
      copub("men0003", "pd0001", 2, 2023),
      copub("men0003", "pd0001", 3, 2030), // no upper bound
      copub("men0003", "pd0002", 4, 2026), // end 2024 + tail 1 → out
      copub("men0003", "pd0002", 5, 2025),
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary.map((s) => [s.cwid, s.gradYear, s.entryYear, s.entryYearSource, s.pubsInWindow, s.pubsAllTime])).toEqual([
      ["pd0002", 2024, 2022, "bridge", 1, 2],
      ["pd0001", null, 2022, "bridge", 2, 3],
    ]);
    expect(report.detail.filter((d) => d.learnerCwid === "pd0001").map((d) => [d.pmid, d.inWindow])).toEqual([
      ["3", true],
      ["2", true],
      ["1", false],
    ]);
  });

  it("a Jenzabar PhD with a conferral year and no entry year gets NO 4-year guess (window unknown)", async () => {
    hoisted.mockPhdFindMany.mockResolvedValue([phd({ mentorCwid: "men0002", menteeCwid: "phd0001" })]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0002", "phd0001", 1, 2022)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary[0]).toMatchObject({
      cwid: "phd0001",
      gradYear: 2024,
      entryYear: null,
      entryYearSource: null,
      pubsInWindow: null,
      pubsAllTime: 1,
    });
    expect(report.detail[0].inWindow).toBeNull();
  });

  it("a roster MD-PhD with no years plus a Jenzabar conferral year still gets NO 4-year guess (the fallback reads the roster's own grad year)", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "MDPHD", graduationYear: null, entryYear: null }),
    ]);
    hoisted.mockPhdFindMany.mockResolvedValue([
      phd({
        mentorCwid: "men0002",
        menteeCwid: "stu0001",
        programType: "MD-PhD",
        conferralYear: 2027,
      }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2021),
      copub("men0002", "stu0001", 2, 2024),
    ]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(report.summary[0]).toMatchObject({
      cwid: "stu0001",
      gradYear: 2027,
      entryYear: null,
      entryYearSource: null,
      pubsInWindow: null,
      pubsAllTime: 2,
    });
    expect(report.detail.map((d) => d.inWindow)).toEqual([null, null]);
  });

  it("gradYears filters Jenzabar by conferralYear and postdocs by end year; only a null admits the year-less rows and reads suggestions at all", async () => {
    hoisted.mockPhdFindMany.mockResolvedValue([
      phd({ mentorCwid: "men0002", menteeCwid: "phd0001", conferralYear: 2024 }),
      phd({ mentorCwid: "men0002", menteeCwid: "phd0002", conferralYear: 2023 }),
      phd({ mentorCwid: "men0002", menteeCwid: "phd0003", conferralYear: null }),
    ]);
    hoisted.mockPostdocFindMany.mockResolvedValue([
      postdoc({ mentorCwid: "men0003", menteeCwid: "pd0001", endDate: new Date("2024-06-30") }),
      postdoc({ mentorCwid: "men0003", menteeCwid: "pd0002", endDate: new Date("2023-06-30") }),
      postdoc({ mentorCwid: "men0003", menteeCwid: "pd0003" }), // ongoing = no year
    ]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([suggestion({ mentorCwid: "men0004", menteeCwid: "sug0001" })]);

    const one = await loadMentoredPublicationsReport({
      types: ALL,
      scopes: ["*"],
      gradYears: [2024],
    });
    expect(one.summary.map((s) => s.cwid).sort()).toEqual(["pd0001", "phd0001"]);
    expect(hoisted.mockSuggestionFindMany).not.toHaveBeenCalled();

    const withNull = await loadMentoredPublicationsReport({
      types: ALL,
      scopes: ["*"],
      gradYears: [2024, null],
    });
    expect(withNull.summary.map((s) => s.cwid).sort()).toEqual([
      "pd0001",
      "pd0003",
      "phd0001",
      "phd0003",
      "sug0001",
    ]);
    expect(hoisted.mockSuggestionFindMany).toHaveBeenCalledTimes(1);

    const all = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"] });
    expect(all.summary).toHaveLength(7);
  });

  it("'all' mode: a learner the roster never had has no all-pubs list, so their mentored set stands in", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", entryYear: 2021 })]);
    hoisted.mockPhdFindMany.mockResolvedValue([phd({ mentorCwid: "men0002", menteeCwid: "phd0001" })]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2023),
      copub("men0002", "phd0001", 2, 2023),
    ]);
    hoisted.mockLearnerPubFindFirst.mockResolvedValue({ pmid: 1 });
    hoisted.mockLearnerPubFindMany.mockResolvedValue([learnerPub("stu0001", 1, 2023), learnerPub("stu0001", 3, 2024)]);
    const report = await loadMentoredPublicationsReport({ types: ALL, scopes: ["*"], pubs: "all" });
    expect(report.summary.map((s) => [s.cwid, s.pubsAllTime])).toEqual([
      ["stu0001", 2],
      ["phd0001", 1],
    ]);
    expect(report.detail.filter((d) => d.learnerCwid === "phd0001").map((d) => [d.pmid, d.withMentor])).toEqual([["2", true]]);
  });
});

describe("types of mentorship (the server-side filter)", () => {
  const suggestion = (mentorCwid: string, menteeCwid: string, tier = "presumptive") => ({
    mentorCwid,
    menteeCwid,
    menteeName: "Ada Learner",
    kind: "alumni_md",
    tier,
    evidence: [{ id: "201", year: 2024, menteeRank: 1, mentorRank: 2, total: 2 }],
  });
  const localPub = {
    pmid: "201",
    title: "Local 201",
    journal: "J Local",
    year: 2024,
    volume: null,
    issue: null,
    pages: null,
    authorsString: "Learner A, Mentor Z",
    fullAuthorsString: null,
    journalAbbrev: null,
    dateAddedToEntrez: null,
    citedByCount: null,
  };

  it("the staging case: an AOC learner with one roster pair and co-author pairs — ['aoc'] shows the roster pair ONLY and counts only its pubs; ALL shows both", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", entryYear: 2021 }),
    ]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion("men0004", "stu0001", "ambiguous"),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 1, 2023)]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub]);

    const aocOnly = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["aoc"] });
    expect(hoisted.mockPhdFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPostdocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockSuggestionFindMany).not.toHaveBeenCalled();
    expect(aocOnly.summary).toHaveLength(1);
    expect(aocOnly.summary[0].mentors).toHaveLength(1);
    expect(aocOnly.summary[0]).toMatchObject({ program: "MD", pubsAllTime: 1, pubsInWindow: 1 });
    expect(aocOnly.summary[0].mentors[0]).toMatchObject({
      cwid: "men0001",
      mentorship: { source: "roster" },
    });
    expect(aocOnly.publications.map((p) => p.pmid)).toEqual(["1"]);
    expect(aocOnly.filters.types).toEqual(["aoc"]);

    const both = await loadMentoredPublicationsReport({
      scopes: ["md"],
      types: ["aoc", "possible"],
    });
    expect(both.summary[0].mentors.map((m) => [m.cwid, m.mentorship.source])).toEqual([
      ["men0001", "roster"],
      ["men0004", "coauthor"],
    ]);
    expect(both.summary[0]).toMatchObject({ program: "MD / MD alum", pubsAllTime: 2 });
  });

  it("['likely'] reads only presumptive suggestions and no other source; ['possible'] only ambiguous; both → both tiers", async () => {
    hoisted.mockSuggestionFindMany.mockResolvedValue([suggestion("men0004", "sug0001")]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub]);
    const likely = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["likely"] });
    expect(hoisted.mockAocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPhdFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPostdocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockSuggestionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dismissedAt: null, tier: { in: ["presumptive"] } } }),
    );
    expect(likely.summary.map((s) => [s.cwid, s.pubsAllTime])).toEqual([["sug0001", 1]]);

    await loadMentoredPublicationsReport({ scopes: ["md"], types: ["possible"] });
    expect(hoisted.mockSuggestionFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { dismissedAt: null, tier: { in: ["ambiguous"] } } }),
    );
    await loadMentoredPublicationsReport({ scopes: ["md"], types: ["possible", "likely"] });
    expect(hoisted.mockSuggestionFindMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { dismissedAt: null, tier: { in: ["presumptive", "ambiguous"] } },
      }),
    );
  });

  it("the per-pair guard holds even when a read returns an unselected tier: ['possible'] with a presumptive row in the result keeps only the ambiguous pair", async () => {
    // Belt and braces for the source-level gates: the mock ignores the
    // `tier` where clause, so only mergePair's own check can drop the row.
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      suggestion("men0004", "sug0001", "presumptive"),
      suggestion("men0004", "sug0002", "ambiguous"),
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub]);
    const possible = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["possible"] });
    expect(possible.summary.map((s) => s.cwid)).toEqual(["sug0002"]);
  });

  it("roster keys gate per bucket: ['aoc'] under '*' drops MD-PhD and ECR rows; a roster pair the suggestion also claims is unaffected", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", programType: "AOC" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", programType: "MDPHD" }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", programType: "ECR" }),
    ]);
    const one = await loadMentoredPublicationsReport({ scopes: ["*"], types: ["aoc"] });
    expect(one.summary.map((s) => s.cwid)).toEqual(["stu0001"]);
    const two = await loadMentoredPublicationsReport({ scopes: ["*"], types: ["mdphd", "ecr"] });
    expect(two.summary.map((s) => s.cwid).sort()).toEqual(["stu0002", "stu0003"]);
  });

  it("['thesis'] reads Jenzabar only; ['postdoc'] reads ED only", async () => {
    hoisted.mockPhdFindMany.mockResolvedValue([
      {
        mentorCwid: "men0002",
        menteeCwid: "phd0001",
        menteeFirstName: "Pia",
        menteeLastName: "Doctoral",
        conferralYear: 2024,
        programType: "PhD",
        mentorFirstName: null,
        mentorLastName: null,
      },
    ]);
    hoisted.mockPostdocFindMany.mockResolvedValue([
      {
        mentorCwid: "men0003",
        menteeCwid: "pd0001",
        menteeFirstName: "Pat",
        menteeLastName: "Postdoc",
        startDate: new Date("2022-07-01"),
        endDate: null,
      },
    ]);
    const thesis = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["thesis"] });
    expect(thesis.summary.map((s) => s.cwid)).toEqual(["phd0001"]);
    expect(hoisted.mockAocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPostdocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockSuggestionFindMany).not.toHaveBeenCalled();
    vi.clearAllMocks();
    hoisted.mockCopubFindMany.mockResolvedValue([]);
    hoisted.mockPubFindMany.mockResolvedValue([]);
    hoisted.mockJifFindMany.mockResolvedValue([]);
    hoisted.mockScholarFindMany.mockResolvedValue([]);
    hoisted.mockPostdocFindMany.mockResolvedValue([
      {
        mentorCwid: "men0003",
        menteeCwid: "pd0001",
        menteeFirstName: "Pat",
        menteeLastName: "Postdoc",
        startDate: new Date("2022-07-01"),
        endDate: null,
      },
    ]);
    const postdoc = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["postdoc"] });
    expect(postdoc.summary.map((s) => s.cwid)).toEqual(["pd0001"]);
    expect(hoisted.mockAocFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPhdFindMany).not.toHaveBeenCalled();
  });
});

describe("faculty-asserted mentees (`manualMentees`)", () => {
  /** One mentor's `manualMentees` override row, as the scan returns it. */
  const override = (mentorCwid: string, entries: unknown) => ({
    entityId: mentorCwid,
    value: typeof entries === "string" ? entries : JSON.stringify(entries),
  });
  const localPub = (pmid: number | string, authorsString = "Mentee M, Second AB, Mentor Z") => ({
    pmid: String(pmid),
    title: `Local ${pmid}`,
    journal: "J Local",
    year: 2024,
    volume: null,
    issue: null,
    pages: null,
    authorsString,
    fullAuthorsString: null,
    journalAbbrev: null,
    dateAddedToEntrez: null,
    citedByCount: null,
  });
  const authorRow = (cwid: string, pmid: number | string, position: number) => ({
    cwid,
    pmid: String(pmid),
    position,
  });

  it("not read unless 'faculty' is selected", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Mia Mentee", cwid: "stu0009", programType: "POSTDOC" }]),
    ]);
    const report = await loadMentoredPublicationsReport({
      scopes: ["*"],
      types: ["aoc", "likely"],
    });
    expect(hoisted.mockOverrideFindMany).not.toHaveBeenCalled();
    expect(report.summary).toEqual([]);
    expect(report.droppedNoCwid).toBe(0);
  });

  it("an entry with a cwid lands as a confirmed faculty pair: program from programType (POSTDOC → Postdoc), name split at the last space, year as grad year; no programType → Other", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [
        { name: "Mia Van Mentee", cwid: "stu0009", programType: "POSTDOC", year: 2024 },
        { name: "Mononym", cwid: "stu0010", programLabel: "Visiting student" },
      ]),
    ]);
    hoisted.mockScholarFindMany.mockResolvedValue([
      { cwid: "men0001", preferredName: "Zed Mentor" },
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(hoisted.mockOverrideFindMany).toHaveBeenCalledWith({
      where: { entityType: "scholar", fieldName: "manualMentees" },
      select: { entityId: true, value: true },
    });
    expect(hoisted.mockAocFindMany).not.toHaveBeenCalled();
    expect(
      report.summary.map((s) => [s.cwid, s.program, s.gradYear, s.firstName, s.lastName]),
    ).toEqual([
      ["stu0009", "Postdoc", 2024, "Mia Van", "Mentee"],
      ["stu0010", "Other", null, null, "Mononym"],
    ]);
    expect(report.summary[0].mentors).toMatchObject([
      {
        cwid: "men0001",
        name: "Zed Mentor",
        mentorship: { program: "postdoc", source: "faculty", tier: "confirmed" },
      },
    ]);
    expect(report.summary[1].mentors[0].mentorship).toEqual({
      program: "other",
      source: "faculty",
      tier: "confirmed",
    });
    // No 4-year guess for a faculty entry's year: the window is unknown.
    expect(report.summary[0]).toMatchObject({
      entryYear: null,
      entryYearSource: null,
      pubsInWindow: null,
    });
    expect(report.droppedNoCwid).toBe(0);
  });

  it("pubs come from the pair's mentee_suggestion row when one exists — read per pair, no tier or dismissedAt filter — and the row label ends 'faculty-asserted'", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Mia Mentee", cwid: "stu0009", programType: "PhD" }]),
    ]);
    hoisted.mockSuggestionFindMany.mockResolvedValue([
      {
        mentorCwid: "men0001",
        menteeCwid: "stu0009",
        evidence: [{ id: "301", year: 2024, menteeRank: 1, mentorRank: 3, total: 3 }],
      },
    ]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub(301)]);
    const report = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(hoisted.mockSuggestionFindMany).toHaveBeenCalledTimes(1);
    expect(hoisted.mockSuggestionFindMany).toHaveBeenCalledWith({
      where: { OR: [{ mentorCwid: "men0001", menteeCwid: "stu0009" }] },
      select: { mentorCwid: true, menteeCwid: true, evidence: true },
    });
    expect(hoisted.mockAuthorFindMany).not.toHaveBeenCalled();
    expect(report.summary[0]).toMatchObject({ cwid: "stu0009", program: "PhD", pubsAllTime: 1 });
    expect(report.detail).toHaveLength(1);
    expect(report.detail[0]).toMatchObject({
      pmid: "301",
      mentorCwid: "men0001",
      mentorship: "PhD · faculty-asserted",
      learnerAuthorPosition: 1,
      withMentor: true,
    });
    expect(report.publications[0].mentors[0].mentorships).toEqual([
      { program: "phd", source: "faculty", tier: "confirmed" },
    ]);
  });

  it("no suggestion row: pubs are the publication_author intersection (confirmed rows of both cwids); one-sided pmids drop; a case-different stored cwid still matches; position 0 → position null", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Mia Mentee", cwid: "stu0009", programType: "AOC" }]),
    ]);
    hoisted.mockAuthorFindMany.mockResolvedValue([
      authorRow("MEN0001", 401, 3),
      authorRow("men0001", 402, 2),
      authorRow("men0001", 403, 1), // mentor only
      authorRow("stu0009", 401, 1),
      authorRow("STU0009", 402, 0), // rank unknown
      authorRow("stu0009", 404, 1), // mentee only
    ]);
    hoisted.mockPubFindMany.mockImplementation(
      async ({ where }: { where: { pmid: { in: string[] } } }) =>
        where.pmid.in.map((pmid) => localPub(pmid)),
    );
    const report = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(hoisted.mockAuthorFindMany).toHaveBeenCalledTimes(1);
    expect(hoisted.mockAuthorFindMany).toHaveBeenCalledWith({
      where: { cwid: { in: ["men0001", "stu0009"] }, isConfirmed: true },
      select: { cwid: true, pmid: true, position: true },
    });
    expect(report.summary[0]).toMatchObject({ cwid: "stu0009", program: "MD", pubsAllTime: 2 });
    expect(
      report.detail.map((d) => [d.pmid, d.learnerAuthorPosition, d.mentorCwid, d.withMentor]),
    ).toEqual([
      ["402", null, "men0001", true],
      ["401", 1, "men0001", true],
    ]);
    expect(report.droppedUnresolved).toBe(0);
  });

  it("roster wins over faculty for the same pair: type stays roster, pubs from the bridge, no per-pair suggestion or publication_author read", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001" }),
    ]);
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Ada Learner", cwid: "stu0001", programType: "POSTDOC" }]),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "stu0001", 7, 2023)]);
    const report = await loadMentoredPublicationsReport({
      scopes: ["*"],
      types: ["aoc", "faculty"],
    });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0].program).toBe("MD");
    expect(report.summary[0].mentors).toMatchObject([
      {
        cwid: "men0001",
        name: "men0001",
        mentorship: { program: "md", source: "roster", tier: "confirmed" },
      },
    ]);
    expect(report.publications.map((p) => p.pmid)).toEqual(["7"]);
    expect(hoisted.mockSuggestionFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockAuthorFindMany).not.toHaveBeenCalled();
  });

  it("ED wins over faculty for the same pair (the merge order is roster, Jenzabar, ED, faculty, co-author)", async () => {
    hoisted.mockPostdocFindMany.mockResolvedValue([
      {
        mentorCwid: "men0001",
        menteeCwid: "pd0001",
        menteeFirstName: "Pat",
        menteeLastName: "Postdoc",
        startDate: new Date("2022-07-01"),
        endDate: null,
      },
    ]);
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Pat Postdoc", cwid: "pd0001" }]),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([copub("men0001", "pd0001", 7, 2023)]);
    const report = await loadMentoredPublicationsReport({
      scopes: ["*"],
      types: ["postdoc", "faculty"],
    });
    expect(report.summary.map((s) => [s.cwid, s.program])).toEqual([["pd0001", "Postdoc"]]);
    expect(report.summary[0].mentors[0].mentorship).toEqual({
      program: "postdoc",
      source: "ed",
      tier: "confirmed",
    });
    expect(report.publications.map((p) => p.pmid)).toEqual(["7"]);
    expect(hoisted.mockAuthorFindMany).not.toHaveBeenCalled();
  });

  it("faculty wins over a co-author suggestion for the same pair when both are selected: type faculty, pubs = the suggestion's evidence, nothing inferred leaks into Program", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [{ name: "Vic Volunteer", cwid: "sug0001", programType: "POSTDOC" }]),
    ]);
    const row = {
      mentorCwid: "men0001",
      menteeCwid: "sug0001",
      menteeName: "Vic Volunteer",
      kind: "volunteer",
      tier: "presumptive",
      evidence: [{ id: "501", year: 2024, menteeRank: 2, mentorRank: 3, total: 3 }],
    };
    hoisted.mockSuggestionFindMany.mockResolvedValue([row]);
    hoisted.mockPubFindMany.mockResolvedValue([localPub(501)]);
    const report = await loadMentoredPublicationsReport({
      scopes: ["md"],
      types: ["faculty", "likely"],
    });
    expect(report.summary).toHaveLength(1);
    expect(report.summary[0]).toMatchObject({
      cwid: "sug0001",
      program: "Postdoc",
      pubsAllTime: 1,
    });
    expect(report.summary[0].mentors.map((m) => m.mentorship)).toEqual([
      { program: "postdoc", source: "faculty", tier: "confirmed" },
    ]);
    expect(report.detail.map((d) => [d.pmid, d.mentorship, d.learnerAuthorPosition])).toEqual([
      ["501", "Postdoc · faculty-asserted", 2],
    ]);
    expect(hoisted.mockAuthorFindMany).not.toHaveBeenCalled();
  });

  it("an entry with no cwid is counted in droppedNoCwid and makes no learner — even when nothing else is in scope; a malformed value is skipped", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [
        { name: "No Cwid", programLabel: "Visiting student" },
        { name: "Also None", year: 2020 },
      ]),
      override("men0002", "{not json"),
      override("men0003", [{ name: "", cwid: "stu0011" }]), // fails validation as a whole
      override("men0004", [{ name: "Real Mentee", cwid: "stu0012" }]),
    ]);
    // men0001 has a Scholar row; the page's "View list" names mentee and mentor.
    hoisted.mockScholarFindMany.mockResolvedValue([{ cwid: "men0001", preferredName: "Zed Mentor" }]);
    const report = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(report.droppedNoCwid).toBe(2);
    expect(report.droppedNoCwidMentees).toEqual([
      { menteeName: "Also None", mentorName: "Zed Mentor" },
      { menteeName: "No Cwid", mentorName: "Zed Mentor" },
    ]);
    expect(report.summary.map((s) => s.cwid)).toEqual(["stu0012"]);

    hoisted.mockOverrideFindMany.mockResolvedValue([override("men0001", [{ name: "No Cwid" }])]);
    const none = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(none.summary).toEqual([]);
    expect(none.droppedNoCwid).toBe(1);
    expect(none.droppedNoCwidMentees).toEqual([{ menteeName: "No Cwid", mentorName: "Zed Mentor" }]);

    // No Scholar row for the mentor → the bare CWID stands in.
    hoisted.mockScholarFindMany.mockResolvedValue([]);
    const bare = await loadMentoredPublicationsReport({ scopes: ["md"], types: ["faculty"] });
    expect(bare.droppedNoCwidMentees).toEqual([{ menteeName: "No Cwid", mentorName: "men0001" }]);
  });

  it("gradYears admits a faculty entry by its year, and a year-less one only with 'unknown'", async () => {
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [
        { name: "Dated Mentee", cwid: "stu0021", year: 2023 },
        { name: "Undated Mentee", cwid: "stu0022" },
      ]),
    ]);
    const dated = await loadMentoredPublicationsReport({
      scopes: ["md"],
      types: ["faculty"],
      gradYears: [2023],
    });
    expect(dated.summary.map((s) => s.cwid)).toEqual(["stu0021"]);
    const unknown = await loadMentoredPublicationsReport({
      scopes: ["md"],
      types: ["faculty"],
      gradYears: [null],
    });
    expect(unknown.summary.map((s) => s.cwid)).toEqual(["stu0022"]);
    const neither = await loadMentoredPublicationsReport({
      scopes: ["md"],
      types: ["faculty"],
      gradYears: [2020],
    });
    expect(neither.summary).toEqual([]);
  });

  it("loadMentoredGradYears unions the faculty entries' years (a cwid-less entry's year is NOT a choice; a cwid'd entry without a year adds 'unknown')", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([{ graduationYear: 2025, programType: "AOC" }]);
    hoisted.mockOverrideFindMany.mockResolvedValue([
      override("men0001", [
        { name: "Dated Mentee", cwid: "stu0021", year: 2019 },
        { name: "No Cwid", year: 2010 },
      ]),
      override("men0002", [{ name: "Undated Mentee", cwid: "stu0022" }]),
    ]);
    expect(await loadMentoredGradYears(["*"], ["aoc"])).toEqual([2025]);
    expect(hoisted.mockOverrideFindMany).not.toHaveBeenCalled();
    expect(await loadMentoredGradYears(["*"], ["aoc", "faculty"])).toEqual([2025, 2019, null]);
    expect(await loadMentoredGradYears(["md"], ["faculty"])).toEqual([2019, null]);
  });
});

describe("loadMentoredGradYears", () => {
  it("roster keys: distinct years within scope, newest first, then null when a row in scope has no year", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      { graduationYear: 2023, programType: "AOC" },
      { graduationYear: 2025, programType: "AOC" },
      { graduationYear: 2025, programType: "MDPHD" },
      { graduationYear: 2024, programType: "ECR" },
      { graduationYear: null, programType: "AOC" },
    ]);
    const ROSTER = ["aoc", "mdphd", "ecr"] as const;
    expect(await loadMentoredGradYears(["*"], ROSTER)).toEqual([2025, 2024, 2023, null]);
    expect(await loadMentoredGradYears(["md"], ROSTER)).toEqual([2025, 2023, null]);
    expect(await loadMentoredGradYears(["ecr"], ROSTER)).toEqual([2024]);
    // The scope gate and the type gate are both applied: an ecr holder selecting only aoc sees nothing.
    expect(await loadMentoredGradYears(["ecr"], ["aoc"])).toEqual([]);
  });

  it("the union over the selected types: a roster bucket's years only when its key is selected; thesis conferral, postdoc end (ongoing = unknown), co-author = unknown", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      { graduationYear: 2025, programType: "AOC" },
      { graduationYear: 2022, programType: "ECR" },
    ]);
    hoisted.mockPhdFindMany.mockResolvedValue([{ conferralYear: 2019 }, { conferralYear: null }]);
    hoisted.mockPostdocFindMany.mockResolvedValue([
      { endDate: new Date("2023-06-30") },
      { endDate: null },
    ]);

    expect(await loadMentoredGradYears(["*"], ["aoc"])).toEqual([2025]);
    expect(hoisted.mockPhdFindMany).not.toHaveBeenCalled();
    expect(hoisted.mockPostdocFindMany).not.toHaveBeenCalled();
    expect(await loadMentoredGradYears(["*"], ["aoc", "ecr"])).toEqual([2025, 2022]);
    expect(await loadMentoredGradYears(["*"], ["aoc", "thesis"])).toEqual([2025, 2019, null]);
    expect(await loadMentoredGradYears(["*"], ["postdoc"])).toEqual([2023, null]);
    expect(hoisted.mockAocFindMany).toHaveBeenCalledTimes(3);
    expect(await loadMentoredGradYears(["*"], ["likely"])).toEqual([null]);
    expect(await loadMentoredGradYears(["md"], ["aoc", "ecr", "possible"])).toEqual([2025, null]);
  });

  it("defaultMentoredPubsYears: the two most recent known years, plus null when offered", () => {
    expect(defaultMentoredPubsYears([2025, 2024, 2023, null])).toEqual([2025, 2024, null]);
    expect(defaultMentoredPubsYears([2024])).toEqual([2024]);
    expect(defaultMentoredPubsYears([null])).toEqual([null]);
    expect(defaultMentoredPubsYears([])).toEqual([]);
  });
});
