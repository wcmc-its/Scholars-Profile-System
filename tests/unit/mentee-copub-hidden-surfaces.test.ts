/**
 * `lib/api/mentoring.ts` — mentor-hidden mentees on the public co-pubs surfaces
 * (#160 follow-up).
 *
 * The /edit "hide mentee" suppression (`entityType="mentee"`, `entityId` =
 * `"{mentorCwid}:{menteeCwid}"`) already gates the profile Mentoring section
 * (components/profile/profile-view.tsx). This suite pins the same choice onto
 * the deeper public surfaces, which previously bypassed it:
 *  - `getAllMentorCoPublications` (the /scholars/<slug>/co-pubs rollup page and
 *    its CSV/DOCX export) must exclude hidden mentees entirely — no group
 *    entries, no count contribution, no per-mentee pub fetch.
 *  - `getMentorMenteePair` (the shared 404 gate for the per-mentee page and its
 *    export route) must return null for a hidden mentee, exactly like a stray
 *    URL.
 *
 * Mirrors the `vi.hoisted` mock idiom of mentoring-aoc-bridge.test.ts, with
 * MENTORING_COPUB_BRIDGE=on so every source reads from mocked Prisma (no
 * ReciterDB). Publication-level suppression (manual-layer) is mocked pass-
 * through — it is orthogonal to the mentee-level hide under test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  menteeCopubPubFindMany,
  aocMenteeFindMany,
  aocMenteeFindFirst,
  suppressionFindMany,
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
  menteeCopubPubFindMany: vi.fn(async () => [] as unknown[]),
  aocMenteeFindMany: vi.fn(async () => [] as unknown[]),
  aocMenteeFindFirst: vi.fn(async () => null as unknown),
  suppressionFindMany: vi.fn(async () => [] as unknown[]),
}));

vi.mock("@/lib/sources/reciterdb", () => ({ withReciterConnection }));
vi.mock("@/lib/headshot", () => ({
  identityImageEndpoint: (cwid: string) => `https://img.example/${cwid}`,
}));
// Publication-level suppression is pass-through: nothing dark, no hidden
// authors. The mentee-level hide is what this suite exercises.
vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: vi.fn(async () => []),
  resolveDarkPmids: vi.fn(async () => new Set<string>()),
  isAuthorHidden: vi.fn(() => false),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    phdMentorRelationship: { findMany: phdFindMany, findFirst: phdFindFirst },
    postdocMentorRelationship: { findMany: postdocFindMany, findFirst: postdocFindFirst },
    studentPhdProgram: { findMany: studentPhdProgramFindMany },
    scholar: { findMany: scholarFindMany, findUnique: scholarFindUnique },
    menteeCopublication: { findMany: menteeCopubFindMany, findFirst: menteeCopubFindFirst },
    menteeCopublicationPub: { findMany: menteeCopubPubFindMany },
    aocMentee: { findMany: aocMenteeFindMany, findFirst: aocMenteeFindFirst },
    suppression: { findMany: suppressionFindMany },
  },
}));

import { getAllMentorCoPublications, getMentorMenteePair } from "@/lib/api/mentoring";

const MENTOR = "mentor01";

const phdRow = (cwid: string, last: string) => ({
  menteeCwid: cwid,
  menteeFirstName: "Pat",
  menteeLastName: last,
  conferralYear: 2021,
  programType: "PhD",
  majorDesc: "Genetics",
});

const copubPub = (pmid: number) => ({
  pub: {
    pmid,
    title: `Co-pub ${pmid}`,
    journal: "J. Test",
    year: 2024,
    doi: null,
    pmcid: null,
    volume: null,
    issue: null,
    pages: null,
    citationCount: 0,
    abstract: null,
    authors: [],
  },
});

/** Hide `menteeCwids` for MENTOR; every other suppression read returns []. */
function hideMentees(...menteeCwids: string[]) {
  suppressionFindMany.mockImplementation(async (...call: unknown[]) => {
    const where = (call[0] as { where?: { entityType?: string } })?.where;
    if (where?.entityType !== "mentee") return [];
    return menteeCwids.map((m) => ({ entityId: `${MENTOR}:${m}` }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MENTORING_COPUB_BRIDGE", "on");
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Two PhD mentees, both with one bridged co-pub.
  phdFindMany.mockResolvedValue([phdRow("phd1", "Visible"), phdRow("phd2", "Hidden")]);
  postdocFindMany.mockResolvedValue([]);
  studentPhdProgramFindMany.mockResolvedValue([]);
  scholarFindMany.mockResolvedValue([]);
  scholarFindUnique.mockResolvedValue({ preferredName: "Mentor Person", postnominal: null });
  aocMenteeFindMany.mockResolvedValue([]);
  aocMenteeFindFirst.mockResolvedValue(null);
  menteeCopubFindMany.mockResolvedValue([
    { menteeCwid: "phd1", count: 1, preview: [] },
    { menteeCwid: "phd2", count: 1, preview: [] },
  ]);
  menteeCopubFindFirst.mockResolvedValue({ mentorCwid: "someoneElse" });
  menteeCopubPubFindMany.mockImplementation(async (...call: unknown[]) => {
    const where = (call[0] as { where?: { menteeCwid?: string } })?.where;
    return where?.menteeCwid === "phd1" ? [copubPub(111)] : [copubPub(222)];
  });
  suppressionFindMany.mockResolvedValue([]);
  phdFindFirst.mockImplementation(async (...call: unknown[]) => {
    const where = (call[0] as { where?: { menteeCwid?: string } })?.where;
    return where?.menteeCwid === "phd1" || where?.menteeCwid === "phd2"
      ? { menteeFirstName: "Pat", menteeLastName: "Mentee" }
      : null;
  });
  postdocFindFirst.mockResolvedValue(null);
});

describe("getAllMentorCoPublications — mentor-hidden mentees (#160 follow-up)", () => {
  it("includes both mentees when nothing is hidden (baseline)", async () => {
    const rollup = await getAllMentorCoPublications(MENTOR);
    expect(rollup.menteeCount).toBe(2);
    expect(rollup.publicationCount).toBe(2);
  });

  it("excludes a hidden mentee from groups, counts, and the pub fetch", async () => {
    hideMentees("phd2");
    const rollup = await getAllMentorCoPublications(MENTOR);

    expect(rollup.menteeCount).toBe(1);
    expect(rollup.publicationCount).toBe(1);
    expect(JSON.stringify(rollup.groups)).not.toContain("phd2");
    // The hidden mentee's co-pub list is never even fetched.
    expect(menteeCopubPubFindMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ menteeCwid: "phd2" }) }),
    );
  });

  it("returns the empty shape when every co-pub mentee is hidden", async () => {
    hideMentees("phd1", "phd2");
    const rollup = await getAllMentorCoPublications(MENTOR);
    expect(rollup).toEqual({ groups: [], publicationCount: 0, menteeCount: 0 });
    expect(menteeCopubPubFindMany).not.toHaveBeenCalled();
  });

  it("scopes the suppression read to this mentor's active mentee rows", async () => {
    hideMentees("phd2");
    await getAllMentorCoPublications(MENTOR);
    expect(suppressionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: "mentee",
          entityId: { startsWith: `${MENTOR}:` },
          contributorCwid: null,
          revokedAt: null,
        }),
      }),
    );
  });
});

describe("getMentorMenteePair — mentor-hidden mentees (#160 follow-up)", () => {
  it("returns the pair for a visible mentee (baseline)", async () => {
    const pair = await getMentorMenteePair(MENTOR, "phd1");
    expect(pair).toMatchObject({ menteeName: "Pat Mentee" });
  });

  it("returns null for a hidden mentee so the per-mentee page and export 404", async () => {
    hideMentees("phd2");
    expect(await getMentorMenteePair(MENTOR, "phd2")).toBeNull();
    // The sibling visible mentee is unaffected.
    expect(await getMentorMenteePair(MENTOR, "phd1")).not.toBeNull();
  });
});
