/**
 * Center Grants tab loader (`getCenterGrantsList`, lib/api/centers.ts).
 *
 * §16 (#52, f978bbe8) dropped the center Grants tab when Spotlight replaced the
 * highlights rows; #556 re-enabled dept/division and left center parity to
 * #481(b); reinstated here with #2066 project grouping and #160/#481(b)
 * suppression. These cases pin the member set (the §3.3
 * active window via `loadActiveCenterMemberCwids`), the Grant query shape,
 * one-card-per-project (the #2066 regression guard), suppression, and paging.
 * All cwids and titles are synthetic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGrantFindMany,
  mockScholarFindMany,
  mockSuppressionFindMany,
  mockCenterMembershipFindMany,
} = vi.hoisted(() => ({
  mockGrantFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    grant: { findMany: mockGrantFindMany },
    scholar: { findMany: mockScholarFindMany },
    suppression: { findMany: mockSuppressionFindMany },
    centerMembership: { findMany: mockCenterMembershipFindMany },
  },
}));

import { getCenterGrantsList } from "@/lib/api/centers";

type Row = {
  cwid: string;
  role: string;
  externalId: string;
  awardNumber: string | null;
  title: string;
  funder: string;
  startDate: Date;
  endDate: Date;
  applId: number | null;
};

const D = {
  funder: "NCI",
  endDate: new Date("2099-12-31"),
  applId: null,
};

const DAY = 24 * 60 * 60 * 1000;
const membership = (
  cwid: string,
  over: Partial<{ startDate: Date | null; endDate: Date | null; membershipRoleKey: string | null }> = {},
) => ({ cwid, startDate: null, endDate: null, membershipRoleKey: "member", ...over });

let memberships: ReturnType<typeof membership>[] = [];
let grantRows: Row[] = [];
let suppressedIds: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  suppressedIds = [];
  memberships = [
    membership("mem00001"),
    membership("mem00002"),
    // Lapsed and pending memberships fall outside the §3.3 active window.
    membership("lapsed01", { endDate: new Date(Date.now() - 30 * DAY) }),
    membership("pending1", { startDate: new Date(Date.now() + 30 * DAY) }),
  ];
  grantRows = [
    // Two members on ONE award: one card, flagged multi-PI.
    { ...D, cwid: "mem00001", role: "PI", externalId: "INFOED-A100-mem00001", awardNumber: "1R01CA111111-01", title: "Shared award", startDate: new Date("2024-06-01"), endDate: new Date("2027-01-01") },
    { ...D, cwid: "mem00002", role: "Co-PI", externalId: "INFOED-A100-mem00002", awardNumber: "1R01CA111111-01", title: "Shared award", startDate: new Date("2024-06-01"), endDate: new Date("2027-01-01") },
    // A solo award that ends later but started earlier.
    { ...D, cwid: "mem00002", role: "PI", externalId: "INFOED-A200-mem00002", awardNumber: "1R01CA222222-01", title: "Solo award", startDate: new Date("2023-01-01"), endDate: new Date("2031-01-01") },
  ];
  mockCenterMembershipFindMany.mockImplementation(() => Promise.resolve(memberships));
  mockSuppressionFindMany.mockImplementation(
    (args?: { where?: { entityId?: { in?: string[] } } }) => {
      const asked = new Set(args?.where?.entityId?.in ?? []);
      return Promise.resolve(
        suppressedIds.filter((id) => asked.has(id)).map((entityId) => ({ entityId })),
      );
    },
  );
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
  mockGrantFindMany.mockImplementation(
    (args?: { where?: { AND?: unknown[]; cwid?: { in?: string[] } } }) => {
      // Sibling candidate query (uses where.AND): answer from the same rows.
      if (args?.where?.AND) {
        return Promise.resolve(
          grantRows.map((r) => ({
            cwid: r.cwid,
            role: r.role,
            externalId: r.externalId,
            awardNumber: r.awardNumber,
          })),
        );
      }
      const allowed = new Set(args?.where?.cwid?.in ?? []);
      return Promise.resolve(grantRows.filter((r) => allowed.has(r.cwid)));
    },
  );
});

describe("getCenterGrantsList", () => {
  it("queries active, non-RePORTER grants of ACTIVE center members only", async () => {
    await getCenterGrantsList("test_center");
    const ownPull = mockGrantFindMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown> })
      .find((a) => !("AND" in a.where));
    expect(ownPull).toBeDefined();
    const where = ownPull!.where as {
      cwid: { in: string[] };
      endDate: { gte: Date };
      source: { not: string };
    };
    expect([...where.cwid.in].sort()).toEqual(["mem00001", "mem00002"]);
    expect(where.endDate.gte).toBeInstanceOf(Date);
    expect(where.source).toEqual({ not: "RePORTER" });
  });

  it("collapses two members on one award into ONE multi-PI card (#2066)", async () => {
    const res = await getCenterGrantsList("test_center");
    expect(res.total).toBe(2);
    const shared = res.hits.filter((h) => h.title === "Shared award");
    expect(shared).toHaveLength(1);
    expect(shared[0].isMultiPi).toBe(true);
  });

  it("neither lists nor counts a suppressed grant", async () => {
    suppressedIds = ["INFOED-A200-mem00002"];
    const res = await getCenterGrantsList("test_center");
    expect(res.total).toBe(1);
    expect(res.hits.map((h) => h.title)).toEqual(["Shared award"]);
  });

  it("returns an empty result with no Grant query when the center has no active members", async () => {
    memberships = [membership("lapsed01", { endDate: new Date(Date.now() - 30 * DAY) })];
    const res = await getCenterGrantsList("test_center", { page: 0 });
    expect(res).toEqual({ hits: [], total: 0, page: 0, pageSize: 20 });
    expect(mockGrantFindMany).not.toHaveBeenCalled();
  });

  it("sorts by start date by default and by end date on sort=end_date", async () => {
    const recent = await getCenterGrantsList("test_center", { sort: "most_recent" });
    expect(recent.hits.map((h) => h.title)).toEqual(["Shared award", "Solo award"]);
    const byEnd = await getCenterGrantsList("test_center", { sort: "end_date" });
    expect(byEnd.hits.map((h) => h.title)).toEqual(["Solo award", "Shared award"]);
  });

  it("pages at 20 projects", async () => {
    grantRows = Array.from({ length: 25 }, (_, i) => ({
      ...D,
      cwid: "mem00001",
      role: "PI",
      externalId: `INFOED-P${String(i).padStart(3, "0")}-mem00001`,
      awardNumber: `1R01CA9${String(i).padStart(5, "0")}-01`,
      title: `Award ${i}`,
      startDate: new Date(Date.UTC(2020, 0, 1 + i)),
    }));
    const p0 = await getCenterGrantsList("test_center", { page: 0 });
    const p1 = await getCenterGrantsList("test_center", { page: 1 });
    expect(p0.total).toBe(25);
    expect(p0.hits).toHaveLength(20);
    expect(p1.hits).toHaveLength(5);
    expect(p1.page).toBe(1);
  });
});
