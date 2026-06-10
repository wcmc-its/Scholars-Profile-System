/**
 * `lib/api/mentoring.ts` — `getMenteesForMentor` co-pub source resilience
 * (issue #843).
 *
 * The per-mentee `copublicationCount` is derived from a LIVE ReciterDB query
 * (WCM-side MariaDB; the SPS→WCM path can be down). The query used to end in a
 * silent `.catch(() => {})`, so an outage left every mentee's count a fallback
 * zero — indistinguishable from a genuine zero, which made the profile's
 * "All publications with mentees →" link and the per-chip badges silently
 * vanish. This suite pins the new contract: the function now reports
 * `copubSourceAvailable` so callers can tell an outage apart from a real zero.
 *
 * Both ReciterDB and Prisma are mocked so the behaviour can be exercised
 * without a live DB. `vi.hoisted` lets the mock factory reference the shared
 * spy without a temporal-dead-zone error (mirrors mentoring-pmids.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withReciterConnection } = vi.hoisted(() => ({
  withReciterConnection: vi.fn(),
}));

const { phdFindMany, postdocFindMany, studentPhdProgramFindMany, scholarFindMany } =
  vi.hoisted(() => ({
    phdFindMany: vi.fn(async () => [] as unknown[]),
    postdocFindMany: vi.fn(async () => [] as unknown[]),
    studentPhdProgramFindMany: vi.fn(async () => [] as unknown[]),
    scholarFindMany: vi.fn(async () => [] as unknown[]),
  }));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany },
    postdocMentorRelationship: { findMany: postdocFindMany },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany },
  },
}));

import { getMenteesForMentor } from "@/lib/api/mentoring";

// One PhD mentee from local Prisma so the mentor clears the
// "no recorded relationships" early-return and the co-pub path is reached.
const PHD_ROW = {
  menteeCwid: "m1",
  menteeFirstName: "Jordan",
  menteeLastName: "Mentee",
  conferralYear: 2022,
  programType: "PhD",
  majorDesc: "Immunology",
};

beforeEach(() => {
  phdFindMany.mockResolvedValue([PHD_ROW]);
  postdocFindMany.mockResolvedValue([]);
  studentPhdProgramFindMany.mockResolvedValue([]);
  scholarFindMany.mockResolvedValue([]);
});

afterEach(() => {
  withReciterConnection.mockReset();
  vi.restoreAllMocks();
});

describe("getMenteesForMentor — copubSourceAvailable (issue #843)", () => {
  it("reports copubSourceAvailable=true and real counts when the co-pub query succeeds", async () => {
    // Call 1 (AOC rows): no reporting_students_mentors hits.
    // Call 2 (co-pub query): one co-authored publication for mentee m1.
    let call = 0;
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        call += 1;
        const rows =
          call === 1
            ? []
            : [
                {
                  mentee_cwid: "m1",
                  pmid: 111,
                  title: "A co-authored study",
                  journal: "J. Test",
                  year: 2021,
                },
              ];
        return fn({ query: async () => rows });
      },
    );

    const { mentees, copubSourceAvailable } = await getMenteesForMentor("mentor01");

    expect(copubSourceAvailable).toBe(true);
    expect(mentees).toHaveLength(1);
    expect(mentees[0].cwid).toBe("m1");
    expect(mentees[0].copublicationCount).toBe(1);
    expect(mentees[0].copublicationPreview).toHaveLength(1);
  });

  it("reports copubSourceAvailable=false and zero counts when the co-pub query throws", async () => {
    // Both withReciterConnection calls reject. The AOC call's own `.catch`
    // swallows its rejection (yielding empty AOC rows; the PhD mentee still
    // makes the mentor non-empty); the co-pub call's rejection is what flips
    // the flag — a fallback zero, NOT a real count.
    withReciterConnection.mockRejectedValue(
      new Error("pool failed to retrieve a connection from pool"),
    );
    // Silence the (now intentional) console.error from the de-silenced catch.
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { mentees, copubSourceAvailable } = await getMenteesForMentor("mentor01");

    expect(copubSourceAvailable).toBe(false);
    expect(mentees).toHaveLength(1);
    expect(mentees[0].copublicationCount).toBe(0);
    expect(mentees[0].copublicationPreview).toEqual([]);
  });

  it("DE-SILENCE: logs the failure with the mentor cwid and co-pub context", async () => {
    withReciterConnection.mockRejectedValue(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await getMenteesForMentor("mentor01");

    expect(errSpy).toHaveBeenCalledTimes(1);
    const [message, err] = errSpy.mock.calls[0];
    expect(String(message)).toContain("mentor01");
    expect(String(message)).toMatch(/co-pub/i);
    expect(err).toBeInstanceOf(Error);
  });

  it("treats the no-mentor-cwid early return as source-available (the query never runs)", async () => {
    withReciterConnection.mockRejectedValue(new Error("must not be called"));

    const result = await getMenteesForMentor("");

    expect(result).toEqual({ mentees: [], copubSourceAvailable: true });
    expect(withReciterConnection).not.toHaveBeenCalled();
  });

  it("treats the no-recorded-mentees early return as source-available", async () => {
    // No local relationships and no AOC rows → empty mentee set, but this is a
    // genuine "this mentor has no mentees", not an outage.
    phdFindMany.mockResolvedValue([]);
    let call = 0;
    withReciterConnection.mockImplementation(
      async (fn: (conn: { query: () => Promise<unknown[]> }) => Promise<unknown>) => {
        call += 1;
        // Only the AOC call should run; if the co-pub call ran it would mean
        // we reached past the empty-relationships guard.
        return fn({ query: async () => [] });
      },
    );

    const result = await getMenteesForMentor("mentor01");

    expect(result).toEqual({ mentees: [], copubSourceAvailable: true });
    // Only the AOC query ran — the empty-relationships guard short-circuits
    // before the co-pub query.
    expect(call).toBe(1);
  });
});
