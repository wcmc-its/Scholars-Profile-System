/**
 * `lib/api/mentoring.ts` — AOC / med-student mentee LIST source switch
 * (issue #928).
 *
 * The AOC mentee list (med-program scholarly-project mentees) used to come from
 * a LIVE `reporting_students_mentors` query against WCM-side ReciterDB. The SPS
 * VPC can't reach ReciterDB in-VPC, so #928 bridges that list the SAME way #926
 * bridged the co-pub count: the nightly export writes
 * `mentoring/aoc-mentees.ndjson` to S3, the import populates the local
 * `aoc_mentee` table, and the EXISTING `MENTORING_COPUB_BRIDGE` flag selects
 * bridge-vs-live for the AOC source too (import-then-flip).
 *
 * This suite pins the source switch for `getMenteesForMentor` and
 * `getMentorMenteePair`:
 *  - flag on  → AOC rows come from `prisma.aocMentee`, ReciterDB is untouched.
 *  - flag off → AOC rows come from the live ReciterDB query (unchanged #843
 *    behaviour).
 *  - a thrown bridge read degrades honestly (the other sources still resolve;
 *    an AOC-only pair returns null) — equal to the current in-VPC behaviour
 *    when ReciterDB is unreachable, so no regression.
 *
 * Mirrors the `vi.hoisted` mock idiom of mentoring-copub-source.test.ts. Both
 * ReciterDB and Prisma are mocked so behaviour is exercised without a live DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

const {
  phdFindMany,
  postdocFindMany,
  studentPhdProgramFindMany,
  scholarFindMany,
  scholarFindUnique,
  phdFindFirst,
  postdocFindFirst,
  menteeCopubFindMany,
  menteeCopubFindFirst,
  aocMenteeFindMany,
  aocMenteeFindFirst,
} = vi.hoisted(() => ({
  phdFindMany: vi.fn(async () => [] as unknown[]),
  postdocFindMany: vi.fn(async () => [] as unknown[]),
  studentPhdProgramFindMany: vi.fn(async () => [] as unknown[]),
  scholarFindMany: vi.fn(async () => [] as unknown[]),
  scholarFindUnique: vi.fn(async () => null as unknown),
  phdFindFirst: vi.fn(async () => null as unknown),
  postdocFindFirst: vi.fn(async () => null as unknown),
  menteeCopubFindMany: vi.fn(async () => [] as unknown[]),
  menteeCopubFindFirst: vi.fn(async () => null as unknown),
  aocMenteeFindMany: vi.fn(async () => [] as unknown[]),
  aocMenteeFindFirst: vi.fn(async () => null as unknown),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/headshot", () => ({
  identityImageEndpoint: (cwid: string) => `https://img.example/${cwid}`,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany, findFirst: phdFindFirst },
    postdocMentorRelationship: { findMany: postdocFindMany, findFirst: postdocFindFirst },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany, findUnique: scholarFindUnique },
    menteeCopublication: { findMany: menteeCopubFindMany, findFirst: menteeCopubFindFirst },
    aocMentee: { findMany: aocMenteeFindMany, findFirst: aocMenteeFindFirst },
  },
}));

import { getMenteesForMentor, getMentorMenteePair } from "@/lib/api/mentoring";

// One PhD mentee from local Prisma so the mentor clears the
// "no recorded relationships" early-return regardless of the AOC source.
const PHD_ROW = {
  menteeCwid: "phd1",
  menteeFirstName: "Robin",
  menteeLastName: "Phd",
  conferralYear: 2020,
  programType: "PhD",
  majorDesc: "Genetics",
};

// One bridged AOC mentee row (table shape: raw reporting_students_mentors row).
const AOC_ROW = {
  mentorCwid: "mentor01",
  menteeCwid: "aoc1",
  firstName: "Alex",
  lastName: "Student",
  graduationYear: 2023,
  programType: "AOC-2025",
};

beforeEach(() => {
  phdFindMany.mockResolvedValue([PHD_ROW]);
  postdocFindMany.mockResolvedValue([]);
  studentPhdProgramFindMany.mockResolvedValue([]);
  scholarFindMany.mockResolvedValue([]);
  scholarFindUnique.mockResolvedValue(null);
  phdFindFirst.mockResolvedValue(null);
  postdocFindFirst.mockResolvedValue(null);
  // Co-pub count is irrelevant to AOC-list assertions; keep it quiet via the
  // bridge so it never reaches ReciterDB and never throws.
  menteeCopubFindMany.mockResolvedValue([]);
  menteeCopubFindFirst.mockResolvedValue({ mentorCwid: "someoneElse" });
  aocMenteeFindMany.mockResolvedValue([]);
  aocMenteeFindFirst.mockResolvedValue(null);
});

afterEach(() => {
  withReciterConnection.mockReset();
  vi.restoreAllMocks();
  delete process.env.MENTORING_COPUB_BRIDGE;
});

describe("getMenteesForMentor — AOC source switch, flag ON (issue #928)", () => {
  beforeEach(() => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    // ReciterDB must never be touched on the flag-on path.
    withReciterConnection.mockRejectedValue(
      new Error("ReciterDB must not be touched when the bridge is on"),
    );
  });

  it("reads the AOC mentee list from the bridge table, not ReciterDB", async () => {
    aocMenteeFindMany.mockResolvedValue([AOC_ROW]);

    const { mentees } = await getMenteesForMentor("mentor01");

    const cwids = mentees.map((m) => m.cwid).sort();
    expect(cwids).toContain("aoc1");
    expect(cwids).toContain("phd1");
    const aocChip = mentees.find((m) => m.cwid === "aoc1");
    expect(aocChip?.fullName).toBe("Alex Student");
    expect(aocChip?.programType).toBe("AOC-2025");
    expect(aocChip?.graduationYear).toBe(2023);
    // The AOC fetch came from the table — ReciterDB was never consulted.
    expect(withReciterConnection).not.toHaveBeenCalled();
    expect(aocMenteeFindMany).toHaveBeenCalled();
  });

  it("collapses duplicate raw AOC rows for the same mentee to one chip", async () => {
    // A pair can repeat across programs; the bridge stores raw rows. The chip
    // dedup is per-CWID, keeping the most specific programType / latest year.
    aocMenteeFindMany.mockResolvedValue([
      { ...AOC_ROW, programType: "AOC", graduationYear: 2022 },
      { ...AOC_ROW, programType: "AOC-2025", graduationYear: 2023 },
    ]);

    const { mentees } = await getMenteesForMentor("mentor01");

    const aocChips = mentees.filter((m) => m.cwid === "aoc1");
    expect(aocChips).toHaveLength(1);
    expect(aocChips[0].programType).toBe("AOC-2025");
    expect(aocChips[0].graduationYear).toBe(2023);
  });
});

describe("getMenteesForMentor — AOC source switch, flag OFF", () => {
  beforeEach(() => {
    delete process.env.MENTORING_COPUB_BRIDGE;
  });

  it("reads the AOC mentee list from the live ReciterDB query", async () => {
    // Call 1 (AOC reporting_students_mentors) → one row. Call 2 (co-pub count
    // query) → no rows. The bridge AOC table must NOT be read on this path.
    let call = 0;
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        call += 1;
        const rows =
          call === 1
            ? [
                {
                  studentCWID: "aoc1",
                  studentFirstName: "Alex",
                  studentLastName: "Student",
                  studentGraduationYear: 2023,
                  programType: "AOC-2025",
                },
              ]
            : [];
        return fn({ query: async () => rows });
      },
    );

    const { mentees } = await getMenteesForMentor("mentor01");

    const aocChip = mentees.find((m) => m.cwid === "aoc1");
    expect(aocChip?.fullName).toBe("Alex Student");
    expect(aocChip?.programType).toBe("AOC-2025");
    // Live path used ReciterDB; the bridge AOC table was untouched.
    expect(withReciterConnection).toHaveBeenCalled();
    expect(aocMenteeFindMany).not.toHaveBeenCalled();
  });
});

describe("getMenteesForMentor — AOC bridge read failure is non-fatal", () => {
  beforeEach(() => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    withReciterConnection.mockRejectedValue(new Error("must not be touched"));
  });

  it("still returns the PhD/postdoc mentees when the AOC bridge read throws", async () => {
    aocMenteeFindMany.mockRejectedValue(new Error("aurora down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { mentees } = await getMenteesForMentor("mentor01");

    // The AOC source is gone, but the PhD mentee from local Prisma survives —
    // no crash, exactly the in-VPC degradation when ReciterDB was unreachable.
    expect(mentees.map((m) => m.cwid)).toContain("phd1");
    expect(mentees.some((m) => m.cwid === "aoc1")).toBe(false);
  });
});

describe("getMentorMenteePair — AOC source switch (issue #928)", () => {
  it("flag ON: resolves the mentee name from the bridge table, not ReciterDB", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    withReciterConnection.mockRejectedValue(
      new Error("ReciterDB must not be touched when the bridge is on"),
    );
    aocMenteeFindFirst.mockResolvedValue({
      firstName: "Alex",
      lastName: "Student",
    });
    scholarFindUnique.mockResolvedValue({ preferredName: "Dr. Mentor", postnominal: null });

    const pair = await getMentorMenteePair("mentor01", "aoc1");

    expect(pair).not.toBeNull();
    expect(pair?.menteeName).toBe("Alex Student");
    expect(withReciterConnection).not.toHaveBeenCalled();
    expect(aocMenteeFindFirst).toHaveBeenCalled();
  });

  it("flag OFF: resolves the mentee name from the live ReciterDB query", async () => {
    delete process.env.MENTORING_COPUB_BRIDGE;
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) =>
        fn({
          query: async () => [{ studentFirstName: "Alex", studentLastName: "Student" }],
        }),
    );
    scholarFindUnique.mockResolvedValue({ preferredName: "Dr. Mentor", postnominal: null });

    const pair = await getMentorMenteePair("mentor01", "aoc1");

    expect(pair?.menteeName).toBe("Alex Student");
    expect(withReciterConnection).toHaveBeenCalled();
    expect(aocMenteeFindFirst).not.toHaveBeenCalled();
  });

  it("flag ON: returns null for an AOC-only pair when the bridge read throws", async () => {
    process.env.MENTORING_COPUB_BRIDGE = "on";
    withReciterConnection.mockRejectedValue(new Error("must not be touched"));
    aocMenteeFindFirst.mockRejectedValue(new Error("aurora down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    // No PhD / postdoc record for this pair, and the AOC bridge read failed —
    // so the pair can't be validated and the page 404s (null), no crash.
    const pair = await getMentorMenteePair("mentor01", "aoc1");

    expect(pair).toBeNull();
  });
});
