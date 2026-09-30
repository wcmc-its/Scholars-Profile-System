/**
 * #2537 (#2234, #2235) — `getCenterMembersUncached`'s FLAT-mode additions:
 *  - `roleCategoryCounts`: whole-center counts per normalized role-category
 *    label, mirroring `departments.ts`'s `roleCategoryCounts` (#17).
 *  - `page`: now the 1-INDEXED display page (fixes #2234 — page 1 used to
 *    render "Showing -19–0" because the loader echoed its internal 0-indexed
 *    `opts.page` straight through).
 * Grouped mode is untouched — no `page` field, no `roleCategoryCounts` field.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockCenterMembershipFindMany,
  mockScholarFindMany,
  mockCenterProgramFindMany,
  mockPublicationTopicGroupBy,
  mockGrantFindMany,
  mockSuppressionFindMany,
  mockMeshSearch,
  mockPublicationAuthorGroupBy,
} = vi.hoisted(() => ({
  mockPublicationAuthorGroupBy: vi.fn(),
  mockMeshSearch: vi.fn(),
  mockCenterMembershipFindMany: vi.fn(),
  mockScholarFindMany: vi.fn(),
  mockCenterProgramFindMany: vi.fn(),
  mockPublicationTopicGroupBy: vi.fn(),
  mockGrantFindMany: vi.fn(),
  mockSuppressionFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    centerMembership: { findMany: mockCenterMembershipFindMany },
    scholar: { findMany: mockScholarFindMany },
    centerProgram: { findMany: mockCenterProgramFindMany },
    publicationTopic: { groupBy: mockPublicationTopicGroupBy },
    publicationAuthor: { groupBy: mockPublicationAuthorGroupBy },
    grant: { findMany: mockGrantFindMany },
    suppression: { findMany: mockSuppressionFindMany },
  },
}));

// Unit Page v2 TOPICS chips — people-index lookup, mocked (no OpenSearch).
vi.mock("@/lib/search", () => ({
  PEOPLE_INDEX: "scholars-people",
  searchClient: () => ({ search: mockMeshSearch }),
}));

import { getCenterMembers } from "@/lib/api/centers";

const ACTIVE = { startDate: null, endDate: null };

function scholarRow(cwid: string, roleCategory: string | null) {
  return {
    cwid,
    preferredName: cwid.toUpperCase(),
    slug: cwid,
    primaryTitle: null,
    primaryDepartment: "Medicine",
    roleCategory,
    overview: null,
    professorialRank: null,
    department: null,
    division: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCenterProgramFindMany.mockResolvedValue([]);
  mockPublicationTopicGroupBy.mockResolvedValue([]);
  mockGrantFindMany.mockResolvedValue([]);
  mockPublicationAuthorGroupBy.mockResolvedValue([]);
  mockSuppressionFindMany.mockResolvedValue([]);
  mockMeshSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
});

describe("getCenterMembers — whole-center roleCategoryCounts (#2235)", () => {
  it("keys counts by normalized display label over the FULL member set, not the page", async () => {
    const rows = [
      scholarRow("f1", "full_time_faculty"),
      scholarRow("f2", "full_time_faculty"),
      scholarRow("a1", "affiliated_faculty"),
      scholarRow("p1", "postdoc"),
    ];
    mockCenterMembershipFindMany.mockResolvedValue(
      rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })),
    );
    mockScholarFindMany.mockResolvedValue(rows);

    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.roleCategoryCounts).toEqual({
      "Full-time faculty": 2,
      "Affiliated faculty": 1,
      Postdoc: 1,
    });
  });

  it("does not tally a null (un-backfilled) roleCategory into any group", async () => {
    const rows = [scholarRow("f1", "full_time_faculty"), scholarRow("n1", null)];
    mockCenterMembershipFindMany.mockResolvedValue(
      rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })),
    );
    mockScholarFindMany.mockResolvedValue(rows);

    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(2);
    expect(result.roleCategoryCounts).toEqual({ "Full-time faculty": 1 });
  });

  it("empty roster returns {} (not undefined)", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([]);
    const result = await getCenterMembers("MEYER", {});
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.roleCategoryCounts).toEqual({});
  });
});

describe("getCenterMembers — 1-indexed flat page contract (#2234)", () => {
  it("opts.page 0 (no ?page= — the default) returns page: 1, the FIRST page", async () => {
    const rows = [scholarRow("f1", "full_time_faculty")];
    mockCenterMembershipFindMany.mockResolvedValue(
      rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })),
    );
    mockScholarFindMany.mockResolvedValue(rows);

    const result = await getCenterMembers("MEYER", { page: 0 });
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.page).toBe(1);
  });

  it("opts.page 1 (the SECOND internal slice) returns page: 2", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      scholarRow(`p${String(i).padStart(3, "0")}`, "full_time_faculty"),
    );
    mockCenterMembershipFindMany.mockResolvedValue(
      rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })),
    );
    mockScholarFindMany.mockResolvedValue(rows);

    const result = await getCenterMembers("MEYER", { page: 1 });
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.page).toBe(2);
    // Still slices the SECOND 20-row window internally (5 remaining rows).
    expect(result.hits).toHaveLength(5);
  });

  it("grouped mode carries no page field at all", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([{ cwid: "a", programCode: "CB", ...ACTIVE }]);
    mockCenterProgramFindMany.mockResolvedValue([{ code: "CB", label: "Cancer Biology" }]);
    mockScholarFindMany.mockResolvedValue([scholarRow("a", "full_time_faculty")]);

    const result = await getCenterMembers("MEYER", {});
    expect(result.mode).toBe("grouped");
    expect((result as Record<string, unknown>).page).toBeUndefined();
    expect((result as Record<string, unknown>).roleCategoryCounts).toBeUndefined();
  });
});

describe("getCenterMembers — CHPC fellows — vocabulary membershipRoleLabel (flat, unprogrammed branch)", () => {
  it("a core_faculty membershipRoleKey surfaces its roleVocabulary label; a research row surfaces null", async () => {
    mockCenterMembershipFindMany.mockResolvedValue([
      {
        cwid: "fellow",
        membershipRoleKey: "core_faculty",
        roleVocabulary: { label: "Core Faculty Fellow" },
        ...ACTIVE,
      },
      {
        cwid: "researcher",
        membershipType: "research",
        membershipRoleKey: "research",
        roleVocabulary: { label: "Research" },
        ...ACTIVE,
      },
    ]);
    mockScholarFindMany.mockResolvedValue([
      scholarRow("fellow", "full_time_faculty"),
      scholarRow("researcher", "full_time_faculty"),
    ]);

    const result = await getCenterMembers("CHPC", {});
    if (result.mode !== "flat") throw new Error("expected flat");
    const byId = new Map(result.hits.map((h) => [h.cwid, h]));
    expect(byId.get("fellow")?.membershipRoleLabel).toBe("Core Faculty Fellow");
    expect(byId.get("researcher")?.membershipRoleLabel).toBeNull();
  });
});

describe("getCenterMembers — TOPICS (MeSH) chips, Unit Page v2", () => {
  it("attaches `topMesh` after the cached read; an OpenSearch failure keeps the roster", async () => {
    const rows = [scholarRow("tst0001", "full_time_faculty"), scholarRow("tst0002", "full_time_faculty")];
    mockCenterMembershipFindMany.mockResolvedValue(rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })));
    mockScholarFindMany.mockResolvedValue(rows);
    mockMeshSearch.mockResolvedValue({
      body: {
        hits: { hits: [{ _id: "tst0001", _source: { topMeshTerms: [{ ui: "D000001", label: "Alpha" }] } }] },
      },
    });

    const ok = await getCenterMembers("TESTCTR", {});
    if (ok.mode !== "flat") throw new Error("expected flat");
    expect(mockMeshSearch).toHaveBeenCalledTimes(1);
    const byCwid = new Map(ok.hits.map((h) => [h.cwid, h]));
    expect(byCwid.get("tst0001")?.topMesh).toEqual([{ ui: "D000001", label: "Alpha" }]);
    expect(byCwid.get("tst0002")).not.toHaveProperty("topMesh");

    mockMeshSearch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const degraded = await getCenterMembers("TESTCTR", {});
    if (degraded.mode !== "flat") throw new Error("expected flat");
    expect(degraded.hits).toHaveLength(2);
    expect(degraded.hits.every((h) => !("topMesh" in h))).toBe(true);
    warn.mockRestore();
  });
});

describe("getCenterMembers — flat roster count sorts, Unit Page v2", () => {
  // 25 members (two pages). Surname order is p000…p024; the counts put the
  // surname-LAST member first, so a sort applied per page (or not at all)
  // would leave it on page 2.
  const rows = Array.from({ length: 25 }, (_, i) =>
    scholarRow(`p${String(i).padStart(3, "0")}`, "full_time_faculty"),
  );
  const PUBS: Record<string, number> = { p024: 50, p010: 30, p003: 10 };
  const GRANTS: Record<string, number> = { p020: 3, p001: 2 };

  beforeEach(() => {
    mockCenterMembershipFindMany.mockResolvedValue(rows.map((r) => ({ cwid: r.cwid, ...ACTIVE })));
    mockScholarFindMany.mockResolvedValue(rows);
    mockPublicationAuthorGroupBy.mockImplementation(
      (args: { where: { cwid: { in: string[] } } }) =>
        Promise.resolve(
          args.where.cwid.in
            .filter((c) => c in PUBS)
            .map((cwid) => ({ cwid, _count: { _all: PUBS[cwid] } })),
        ),
    );
    // `loadRosterCounts("center")` reads active grant ROWS (for #160
    // suppression), one row per grant.
    mockGrantFindMany.mockImplementation((args: { where: { cwid: { in: string[] } } }) =>
      Promise.resolve(
        args.where.cwid.in.flatMap((cwid) =>
          Array.from({ length: GRANTS[cwid] ?? 0 }, (_, i) => ({
            cwid,
            externalId: `${cwid}-g${i}`,
            id: `${cwid}-g${i}`,
          })),
        ),
      ),
    );
  });

  it("'pubs' ranks the WHOLE roster by the displayed pub count before paging", async () => {
    const result = await getCenterMembers("SORTCTR", { page: 0, sort: "pubs" });
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.total).toBe(25);
    expect(result.hits.slice(0, 3).map((h) => h.cwid)).toEqual(["p024", "p010", "p003"]);
    expect(result.hits.slice(0, 3).map((h) => h.pubCount)).toEqual([50, 30, 10]);
    // Ties (0 pubs) fall back to surname order.
    expect(result.hits[3].cwid).toBe("p000");
  });

  it("'grants' ranks by the displayed grant count", async () => {
    const result = await getCenterMembers("SORTCTR", { page: 0, sort: "grants" });
    if (result.mode !== "flat") throw new Error("expected flat");
    expect(result.hits.slice(0, 2).map((h) => h.cwid)).toEqual(["p020", "p001"]);
    expect(result.hits.slice(0, 2).map((h) => h.grantCount)).toEqual([3, 2]);
  });

  it("the default surname sort leaves the top-pubs member on page 2", async () => {
    const page0 = await getCenterMembers("SORTCTR", { page: 0 });
    if (page0.mode !== "flat") throw new Error("expected flat");
    expect(page0.hits[0].cwid).toBe("p000");
    expect(page0.hits.map((h) => h.cwid)).not.toContain("p024");
  });
});
