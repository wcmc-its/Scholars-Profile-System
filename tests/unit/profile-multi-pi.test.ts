/**
 * `grants[].isMultiPi` on the profile payload — the project-level fact that
 * relabels the CONTACT PI of an NIH multiple-PI award as MPI.
 *
 * The point of these tests is the GROUPING KEY. `lib/api/profile.ts` must use
 * the funding index's key — `coreProjectNum(awardNumber) ?? accountNumber`
 * (lib/funding-projection.ts) — not the per-row `externalId`
 * (`INFOED-{account}-{cwid}`, unique per row) that the department and division
 * lists still group their CARDS on. The two disagree on renewals and
 * supplements, and the profile contradicting `/search?type=funding` about which
 * award is multi-PI is exactly the defect this guards.
 *
 * #2066 — those lists no longer derive `isMultiPi` from their card key; they
 * call the same `multiPiExternalIds` this file exercises. Only the card
 * grouping is still per-row, so do not "fix" them by reading the card key here.
 *
 * The Prisma mock below is not a stub that returns a fixed row set: it
 * INTERPRETS the `where` the loader sends (the `startsWith` / `contains` OR
 * arms plus the active-scholar predicate) against a small corpus. A mock that
 * ignored the filter could not tell a correct candidate query from one that
 * never fetches the sibling PD/PI at all.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

/** One row of the fake `grant` table, plus the owning scholar's visibility. */
type Row = {
  cwid: string;
  role: string;
  externalId: string;
  awardNumber: string | null;
  /** Backs the `scholar: { deletedAt: null, status: "active" }` relation filter. */
  scholarActive?: boolean;
  scholarDeleted?: boolean;
};

/** The corpus the mocked `grant.findMany` queries. Set per test. */
let corpus: Row[] = [];
/** The cwid whose profile is being loaded. Set per test. */
let subjectCwid = "aaa9001";

/** Rows the loader's nested `scholar.grants` relation would return: the
 *  subject's own rows, hydrated into the shape the mapper reads. */
function ownRows(): unknown[] {
  return corpus
    .filter((r) => r.cwid === subjectCwid)
    .map((r) => ({
      title: `Study ${r.externalId}`,
      role: r.role,
      funder: "NCI",
      source: "InfoEd",
      startDate: new Date("2023-01-01"),
      endDate: new Date("2028-12-31"),
      externalId: r.externalId,
      awardNumber: r.awardNumber,
      programType: "Grant",
      primeSponsor: "NCI",
      primeSponsorRaw: "National Cancer Institute",
      directSponsor: "NCI",
      directSponsorRaw: "National Cancer Institute",
      mechanism: "R01",
      nihIc: "NCI",
      isSubaward: false,
      applId: null,
      abstract: null,
      abstractSource: null,
      publications: [],
    }));
}

/** Minimal interpreter for the candidate query's `where`. Supports exactly the
 *  shape `lib/api/profile.ts` sends: `{ AND: [ {scholar:{…}}, { OR: arms } ] }`
 *  with `externalId.startsWith` / `awardNumber.contains` arms. Anything else
 *  throws, so a silently-reshaped query fails loudly instead of matching all. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  const and = where.AND as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(and) || and.length !== 2) {
    throw new Error(`unexpected candidate-query where: ${JSON.stringify(where)}`);
  }
  const [visibility, orClause] = and;
  const scholarFilter = visibility.scholar as
    | { deletedAt: null; status: string }
    | undefined;
  if (!scholarFilter) {
    throw new Error("candidate query must carry the active-scholar predicate");
  }
  if (scholarFilter.status === "active" && row.scholarActive === false) return false;
  if (scholarFilter.deletedAt === null && row.scholarDeleted === true) return false;

  const arms = orClause.OR as Array<Record<string, { startsWith?: string; contains?: string }>>;
  if (!Array.isArray(arms)) {
    throw new Error(`unexpected candidate-query OR: ${JSON.stringify(orClause)}`);
  }
  return arms.some((arm) => {
    if (arm.externalId?.startsWith !== undefined) {
      return row.externalId.startsWith(arm.externalId.startsWith);
    }
    if (arm.awardNumber?.contains !== undefined) {
      return (row.awardNumber ?? "").includes(arm.awardNumber.contains);
    }
    throw new Error(`unexpected candidate-query arm: ${JSON.stringify(arm)}`);
  });
}

const grantFindMany = vi.fn(async (args: { where: Record<string, unknown> }) =>
  corpus.filter((r) => matches(r, args.where)),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: {
      findFirst: vi.fn(async () => ({
        cwid: subjectCwid,
        slug: "multi-pi-fixture",
        preferredName: "Test Scholar",
        fullName: "Test Q. Scholar",
        primaryTitle: "Professor",
        primaryDepartment: "Medicine",
        email: null,
        overview: null,
        headshotUrl: null,
        hasClinicalProfile: false,
        deletedAt: null,
        status: "active",
        appointments: [],
        profileAppointments: [],
        honors: [],
        educations: [],
        grants: ownRows(),
        topicAssignments: [],
        coiActivities: [],
        publicationScores: [],
      })),
    },
    grant: { findMany: grantFindMany },
    fieldOverride: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    publicationAuthor: { findMany: vi.fn(async () => []) },
    personNihProfile: { findFirst: vi.fn(async () => null) },
    suppression: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => []) },
    division: { findMany: vi.fn(async () => []) },
    center: { findMany: vi.fn(async () => []) },
    // #2542 — center leadership titles read `orgUnitRoleAssignment` (with `center` as
    // the pre-backfill dual-read fallback).
    orgUnitRoleAssignment: { findMany: vi.fn(async () => []) },
    // #2542 Phase D — department/division leadership label vocabulary lookup.
    orgUnitRole: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    $queryRawUnsafe: vi.fn(async () => []),
  },
}));

type GrantOut = { role: string; isMultiPi: boolean; awardNumber: string | null };

/** Load the profile and return its grants, keyed by role for readability.
 *  A fresh slug per call — the loader is wrapped in React `cache()`. */
let slugSeq = 0;
async function loadGrants(): Promise<GrantOut[]> {
  const { getScholarFullProfileBySlug } = await import("@/lib/api/profile");
  const payload = await getScholarFullProfileBySlug(`multi-pi-fixture-${slugSeq++}`);
  expect(payload).not.toBeNull();
  return payload!.grants as GrantOut[];
}

beforeEach(() => {
  grantFindMany.mockClear();
  subjectCwid = "aaa9001";
});

describe("profile grants[].isMultiPi — the multi-PI rule", () => {
  it("flags BOTH scholars when two distinct PI-standing cwids share a project", async () => {
    // One InfoEd Account_Number, two people: the contact PI and the non-contact
    // PD/PI InfoEd writes as `Co-PI`.
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-11111-aaa9001", awardNumber: "R01 CA245678" },
      { cwid: "bbb9002", role: "Co-PI", externalId: "INFOED-11111-bbb9002", awardNumber: "R01 CA245678" },
    ];

    subjectCwid = "aaa9001";
    const contactPi = await loadGrants();
    expect(contactPi).toHaveLength(1);
    expect(contactPi[0].role).toBe("PI");
    expect(contactPi[0].isMultiPi).toBe(true);

    subjectCwid = "bbb9002";
    const mpi = await loadGrants();
    expect(mpi[0].role).toBe("Co-PI");
    expect(mpi[0].isMultiPi).toBe(true);
  });

  it("does NOT flag a sole-PI project", async () => {
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-22222-aaa9001", awardNumber: "R01 CA111111" },
      { cwid: "ccc9003", role: "Co-I", externalId: "INFOED-22222-ccc9003", awardNumber: "R01 CA111111" },
      { cwid: "ddd9004", role: "Key Personnel", externalId: "INFOED-22222-ddd9004", awardNumber: "R01 CA111111" },
    ];
    const grants = await loadGrants();
    expect(grants[0].isMultiPi).toBe(false);
  });

  it("does NOT flag a renewal/supplement — same cwid, two Account_Numbers, one core project", async () => {
    // InfoEd emits multiple Account_Numbers per project (renewal years,
    // supplements, no-cost extensions). Counting ROWS instead of DISTINCT cwids
    // would read this sole-PI award as multi-PI.
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-33333-aaa9001", awardNumber: "1R01 CA333333-01" },
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-44444-aaa9001", awardNumber: "5R01 CA333333-02" },
    ];
    const grants = await loadGrants();
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.isMultiPi)).toEqual([false, false]);
  });

  it("flags an MPI listed on the RENEWAL account number — the key must be coreProjectNum, not externalId", async () => {
    // THE KEY TEST. The two rows share a `coreProjectNum` ("R01CA555555") but
    // NOT an Account_Number and not even an award-number STRING. Grouping on
    // `externalId` (unique per row) or on the raw award-number string puts them
    // in different projects and loses the flag; `coreProjectNum(awardNumber) ??
    // accountNumber` — the funding index's key — keeps them together.
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-55555-aaa9001", awardNumber: "1R01 CA555555-01" },
      { cwid: "bbb9002", role: "Co-PI", externalId: "INFOED-66666-bbb9002", awardNumber: "5R01 CA555555-02A1" },
    ];
    const grants = await loadGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0].isMultiPi).toBe(true);
  });

  it("counts `PI-Subaward` as PI standing", async () => {
    corpus = [
      { cwid: "aaa9001", role: "PI-Subaward", externalId: "INFOED-77777-aaa9001", awardNumber: "R01 CA777777" },
      { cwid: "bbb9002", role: "Co-PI", externalId: "INFOED-77777-bbb9002", awardNumber: "R01 CA777777" },
    ];
    const grants = await loadGrants();
    expect(grants[0].isMultiPi).toBe(true);
  });

  it("leaves a Co-PI unflagged when the contact PI is at another institution", async () => {
    // InfoEd flags only the contact PI as `PI`, so a WCM scholar can be the
    // non-contact PD/PI of an award whose contact PI is elsewhere — one WCM row,
    // no second cwid, `isMultiPi` false. The pill still reads MPI from the ROLE
    // alone (lib/funding-roles.ts), which is what makes the flag optional there.
    corpus = [
      { cwid: "aaa9001", role: "Co-PI", externalId: "INFOED-88888-aaa9001", awardNumber: "R01 CA888888" },
    ];
    const grants = await loadGrants();
    expect(grants[0].role).toBe("Co-PI");
    expect(grants[0].isMultiPi).toBe(false);
  });

  it("does not let a suppressed or soft-deleted sibling scholar flip the flag", async () => {
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-99999-aaa9001", awardNumber: "R01 CA999999" },
      {
        cwid: "bbb9002",
        role: "Co-PI",
        externalId: "INFOED-99999-bbb9002",
        awardNumber: "R01 CA999999",
        scholarActive: false,
      },
      {
        cwid: "ccc9003",
        role: "Co-PI",
        externalId: "INFOED-99999-ccc9003",
        awardNumber: "R01 CA999999",
        scholarDeleted: true,
      },
    ];
    const grants = await loadGrants();
    expect(grants[0].isMultiPi).toBe(false);
  });

  it("issues ONE candidate query, and none at all for a scholar with no grants", async () => {
    corpus = [
      { cwid: "aaa9001", role: "PI", externalId: "INFOED-12121-aaa9001", awardNumber: "R01 CA121212" },
      { cwid: "bbb9002", role: "Co-PI", externalId: "INFOED-12121-bbb9002", awardNumber: "R01 CA121212" },
    ];
    await loadGrants();
    expect(grantFindMany).toHaveBeenCalledTimes(1);

    grantFindMany.mockClear();
    corpus = [];
    const none = await loadGrants();
    expect(none).toEqual([]);
    expect(grantFindMany).not.toHaveBeenCalled();
  });
});
