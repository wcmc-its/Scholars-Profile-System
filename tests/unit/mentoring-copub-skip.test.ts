/**
 * `lib/api/mentoring.ts` — `getMenteesForMentor({ includeCopubs })` (#955 #5).
 *
 * The `/edit` Mentees panel renders only name + hide-state, never the per-mentee
 * co-pub count, so the edit-context seam passes `includeCopubs: false` to skip
 * the co-pub source (a cross-VPC ReciterDB query, or the local bridge table) on
 * every edit load. This suite pins that skip with the bridge ON (so the co-pub
 * source is `prisma.menteeCopublication`, cleanly isolated from the AOC identity
 * fetch): with the flag, the co-pub table is never read and ReciterDB is never
 * touched, while mentee identity + program still resolve.
 *
 * Mirrors the `vi.hoisted` mock idiom of mentoring-aoc-bridge.test.ts.
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
  menteeCopubFindMany,
  menteeCopubFindFirst,
  aocMenteeFindMany,
} = vi.hoisted(() => ({
  phdFindMany: vi.fn(async () => [] as unknown[]),
  postdocFindMany: vi.fn(async () => [] as unknown[]),
  studentPhdProgramFindMany: vi.fn(async () => [] as unknown[]),
  scholarFindMany: vi.fn(async () => [] as unknown[]),
  menteeCopubFindMany: vi.fn(async () => [] as unknown[]),
  menteeCopubFindFirst: vi.fn(async () => null as unknown),
  aocMenteeFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/headshot", () => ({
  identityImageEndpoint: (cwid: string) => `https://img.example/${cwid}`,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany },
    postdocMentorRelationship: { findMany: postdocFindMany },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany },
    menteeCopublication: { findMany: menteeCopubFindMany, findFirst: menteeCopubFindFirst },
    aocMentee: { findMany: aocMenteeFindMany },
  },
}));

import { getMenteesForMentor } from "@/lib/api/mentoring";

const PHD_ROW = {
  menteeCwid: "phd1",
  menteeFirstName: "Robin",
  menteeLastName: "Phd",
  conferralYear: 2020,
  programType: "PhD",
  majorDesc: "Genetics",
};

beforeEach(() => {
  // Bridge ON: AOC identity + co-pub both source from local tables, so ReciterDB
  // is never the AOC fallback — `withReciterConnection` calls are then unambiguously
  // the co-pub query (which we're asserting is skipped).
  process.env.MENTORING_COPUB_BRIDGE = "on";
  phdFindMany.mockResolvedValue([PHD_ROW]);
  postdocFindMany.mockResolvedValue([]);
  studentPhdProgramFindMany.mockResolvedValue([]);
  scholarFindMany.mockResolvedValue([]);
  menteeCopubFindMany.mockResolvedValue([{ menteeCwid: "phd1", count: 4, preview: [] }]);
  menteeCopubFindFirst.mockResolvedValue({ mentorCwid: "someone" });
  aocMenteeFindMany.mockResolvedValue([]);
  withReciterConnection.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MENTORING_COPUB_BRIDGE;
});

describe("getMenteesForMentor — includeCopubs:false (#955 #5)", () => {
  it("skips the co-pub source entirely but still returns identity + program", async () => {
    const { mentees, copubSourceAvailable } = await getMenteesForMentor("mentor01", {
      includeCopubs: false,
    });

    const phd = mentees.find((m) => m.cwid === "phd1");
    expect(phd?.fullName).toBe("Robin Phd");
    expect(phd?.programName).toBe("Genetics");
    // Co-pub work skipped: count is a deliberate 0, source reported unavailable.
    expect(phd?.copublicationCount).toBe(0);
    expect(phd?.copublicationPreview).toEqual([]);
    expect(copubSourceAvailable).toBe(false);
    // The co-pub table is never read, and ReciterDB is never touched.
    expect(menteeCopubFindMany).not.toHaveBeenCalled();
    expect(withReciterConnection).not.toHaveBeenCalled();
  });

  it("reads the co-pub source by default (includeCopubs defaults to true)", async () => {
    const { mentees, copubSourceAvailable } = await getMenteesForMentor("mentor01");

    expect(menteeCopubFindMany).toHaveBeenCalled();
    expect(copubSourceAvailable).toBe(true);
    expect(mentees.find((m) => m.cwid === "phd1")?.copublicationCount).toBe(4);
  });
});
