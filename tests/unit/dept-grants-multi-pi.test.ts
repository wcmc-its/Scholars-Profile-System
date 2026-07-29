/**
 * #2066 — `isMultiPi` on a DEPARTMENT grant card (`lib/api/dept-lists.ts`).
 *
 * The twin of the `getDivisionGrantsList` block in `api-div-roster-union.test.ts`.
 * Both surfaces derive this flag independently, and `lib/api/divisions.ts` is a
 * near-verbatim copy of `lib/api/dept-lists.ts` — the same duplication that let
 * `search-index-docs.ts` and `data-quality.ts` disagree about whether `Co-PI` is
 * a PI role. Covering only one of the pair is how the next drift ships.
 *
 * The defect being guarded: `isMultiPi` was read off a grouping keyed on
 * `externalId` (`INFOED-{account}-{cwid}`), which EMBEDS the cwid. Every group
 * was therefore a singleton and `piCwids.length >= 2` was structurally
 * unsatisfiable — the flag could never be true for any department, ever.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGrantFindMany, mockScholarFindMany, mockSuppressionFindMany } =
  vi.hoisted(() => ({
    mockGrantFindMany: vi.fn(),
    mockScholarFindMany: vi.fn(),
    mockSuppressionFindMany: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    grant: { findMany: mockGrantFindMany },
    scholar: { findMany: mockScholarFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

import { getDeptGrantsList } from "@/lib/api/dept-lists";

/** Two PD/PIs on ONE funding project (same InfoEd Account_Number, distinct
 *  cwids) plus a single-PI project as the negative control. InfoEd flags only
 *  the contact PI, so the second PD/PI arrives as `Co-PI` — which in this
 *  system means NIH multiple-PI, not NSF co-principal-investigator. */
const GRANT_ROWS = [
  {
    cwid: "mpi00001",
    role: "PI",
    externalId: "INFOED-A100-mpi00001",
    awardNumber: "1R01CA245678-01",
    title: "Multi-PI project",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
    applId: null,
  },
  {
    cwid: "mpi00002",
    role: "Co-PI",
    externalId: "INFOED-A100-mpi00002",
    awardNumber: "1R01CA245678-01",
    title: "Multi-PI project",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
    applId: null,
  },
  {
    cwid: "solo0001",
    role: "PI",
    externalId: "INFOED-A200-solo0001",
    awardNumber: "1R01CA999999-01",
    title: "Single-PI project",
    funder: "NCI",
    startDate: new Date("2024-01-01"),
    endDate: new Date("2029-12-31"),
    applId: null,
  },
];

/** Routes the two `grant.findMany` reads: the suppression/count projection
 *  (`select: { externalId, id }`) and then the full pull. */
function serveGrants(rows: typeof GRANT_ROWS) {
  return (args?: { select?: Record<string, true> }) =>
    Promise.resolve(
      args?.select?.title
        ? rows
        : rows.map((r) => ({ externalId: r.externalId, id: r.externalId })),
    );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSuppressionFindMany.mockResolvedValue([]);
  mockGrantFindMany.mockImplementation(serveGrants(GRANT_ROWS));
  mockScholarFindMany.mockImplementation((args?: { where?: { cwid?: { in?: string[] } } }) =>
    Promise.resolve(
      (args?.where?.cwid?.in ?? []).map((cwid) => ({
        cwid,
        preferredName: cwid.toUpperCase(),
        slug: cwid,
        roleCategory: "faculty",
      })),
    ),
  );
});

describe("getDeptGrantsList — isMultiPi (#2066)", () => {
  it("flags BOTH rows of a two-PD/PI project, and not the single-PI project", async () => {
    const { hits } = await getDeptGrantsList("NEURO", { page: 0 });
    expect(
      Object.fromEntries(hits.map((h) => [h.externalId, h.isMultiPi])),
    ).toEqual({
      // The CONTACT PI reads MPI too. Flagging only the non-contact PD/PI was
      // the #2065 inversion, where the contact PI read a plain "PI".
      "INFOED-A100-mpi00001": true,
      "INFOED-A100-mpi00002": true,
      "INFOED-A200-solo0001": false,
    });
  });

  it("does not flag a renewal — one scholar on two Account_Numbers, one core project", async () => {
    // `coreProjectNum` collapses "1R01CA245678-01" and "5R01CA245678-02" into
    // one project. Counting DISTINCT CWIDS rather than rows is what keeps that
    // from reading as multi-PI.
    mockGrantFindMany.mockImplementation(
      serveGrants([
        GRANT_ROWS[0],
        { ...GRANT_ROWS[0], externalId: "INFOED-A300-mpi00001", awardNumber: "5R01CA245678-02" },
      ]),
    );

    const { hits } = await getDeptGrantsList("NEURO", { page: 0 });
    expect(hits.map((h) => h.isMultiPi)).toEqual([false, false]);
  });

  it("does not flag a PD/PI plus a Co-Investigator", async () => {
    mockGrantFindMany.mockImplementation(
      serveGrants([GRANT_ROWS[0], { ...GRANT_ROWS[1], role: "Co-I" }]),
    );

    const { hits } = await getDeptGrantsList("NEURO", { page: 0 });
    expect(hits.some((h) => h.isMultiPi)).toBe(false);
  });

  it("does not flag a project whose second PD/PI row is suppressed (#160)", async () => {
    // A colleague who hid their own grant row must not keep flipping the flag.
    mockSuppressionFindMany.mockResolvedValue([{ entityId: "INFOED-A100-mpi00002" }]);

    const { hits } = await getDeptGrantsList("NEURO", { page: 0 });
    expect(hits.some((h) => h.isMultiPi)).toBe(false);
  });
});
