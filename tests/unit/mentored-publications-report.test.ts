/**
 * `lib/edit/mentored-publications-report.ts` unit tests — fake `@/lib/db` at
 * the module boundary (the same idiom as
 * `cancer-center-publications-report.test.ts`), no live DB:
 *   - `aocMentee.findMany`                (learners × mentors × programs)
 *   - `menteeCopublicationPub.findMany`   (the bridge's (mentor, mentee, pmid) rows)
 *   - `publication.findMany`             (dateAdded / journalAbbrev / iCite)
 *   - `journalImpactFactor.findMany`     (JIF by normalized abbreviation)
 *   - `scholar.findMany`                 (mentor display names)
 *
 * Behaviors protected: the window rule incl. the `gradYear - 4` fallback and
 * the tail; a pub shared with two mentors counts ONCE in the learner's
 * summary; scope filtering by program bucket; the gradYears filter; the
 * learner's author position derived from the bridge's per-author CWIDs;
 * citations from iCite (`citedByCount`), never the Scopus count in the JSON.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  mockAocFindMany: vi.fn(),
  mockCopubFindMany: vi.fn(),
  mockPubFindMany: vi.fn(),
  mockJifFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    read: {
      aocMentee: { findMany: hoisted.mockAocFindMany },
      menteeCopublicationPub: { findMany: hoisted.mockCopubFindMany },
      publication: { findMany: hoisted.mockPubFindMany },
      journalImpactFactor: { findMany: hoisted.mockJifFindMany },
      scholar: { findMany: hoisted.mockScholarFindMany },
    },
    write: {},
  },
  prisma: {},
}));
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({ HIGH_IMPACT_THRESHOLD: 10 }));

import {
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
};

const aoc = (o: Partial<Aoc> & Pick<Aoc, "mentorCwid" | "menteeCwid">): Aoc => ({
  firstName: "Ada",
  lastName: "Learner",
  graduationYear: 2025,
  entryYear: null,
  programType: "AOC",
  ...o,
});

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
});

describe("window rule", () => {
  it("entryYear <= year <= gradYear + tail; unknowns never count", () => {
    expect(inProgramWindow(2022, 2021, 2025, 1)).toBe(true);
    expect(inProgramWindow(2026, 2021, 2025, 1)).toBe(true);
    expect(inProgramWindow(2027, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(2027, 2021, 2025, 2)).toBe(true);
    expect(inProgramWindow(2020, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(null, 2021, 2025, 1)).toBe(false);
    expect(inProgramWindow(2022, null, 2025, 1)).toBe(false);
    expect(inProgramWindow(2022, 2021, null, 1)).toBe(false);
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
    expect(hoisted.mockCopubFindMany).not.toHaveBeenCalled();
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
      pubsAllTime: 1,
      highImpactInWindow: 1,
      firstAuthorInWindow: 1,
      // Resolved name for the scholar row; the bare cwid for the unresolved one; sorted.
      mentors: ["men0002", "Zed Mentor"],
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
      inWindow: true,
    });
    expect(report.detail[0].dateAdded?.toISOString().slice(0, 10)).toBe("2023-05-01");
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
    expect(report.filters).toEqual({ scopes: ["*"], gradYears: [2024, 2025], tail: 1 });

    await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(hoisted.mockAocFindMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: undefined }));
  });

  it("sorts summary by gradYear, lastName, firstName and detail the same then year desc", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0002", lastName: "Baker", firstName: "Bo", graduationYear: 2024 }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0001", lastName: "Baker", firstName: "Al", graduationYear: 2024 }),
      aoc({ mentorCwid: "men0001", menteeCwid: "stu0003", lastName: "Adams", firstName: "Cy", graduationYear: 2025 }),
    ]);
    hoisted.mockCopubFindMany.mockResolvedValue([
      copub("men0001", "stu0001", 1, 2021),
      copub("men0001", "stu0001", 2, 2023),
    ]);
    const report = await loadMentoredPublicationsReport({ scopes: ["*"] });
    expect(report.summary.map((s) => s.cwid)).toEqual(["stu0001", "stu0002", "stu0003"]);
    expect(report.detail.map((d) => d.pmid)).toEqual([2, 1]);
  });
});

describe("loadMentoredGradYears", () => {
  it("distinct years within scope, newest first", async () => {
    hoisted.mockAocFindMany.mockResolvedValue([
      { graduationYear: 2023, programType: "AOC" },
      { graduationYear: 2025, programType: "AOC" },
      { graduationYear: 2025, programType: "MDPHD" },
      { graduationYear: 2024, programType: "ECR" },
      { graduationYear: null, programType: "AOC" },
    ]);
    expect(await loadMentoredGradYears(["*"])).toEqual([2025, 2024, 2023]);
    expect(await loadMentoredGradYears(["md"])).toEqual([2025, 2023]);
    expect(await loadMentoredGradYears(["ecr"])).toEqual([2024]);
  });
});
