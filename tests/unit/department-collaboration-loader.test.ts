/**
 * `buildDepartmentCollaboration` — the loader behind the PUBLIC, unauthenticated
 * GET /api/departments/[slug]/collaboration.
 *
 * Covers the public gate (#536 role carve, fail-closed on the raw column), the
 * division grouping (LDAP divCode → manual roster → "No division"), the legend
 * order + palette, the ≥2-member paper rule, publication suppression (dark pmid
 * and per-author hide) and the grant-axis gate. Membership indices (`m`) are
 * positional into `nodes`, so every drop must keep them aligned.
 *
 * Synthetic cwids / names only — the repo is public.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  scholarFindMany,
  divisionFindMany,
  divisionMembershipFindMany,
  authorFindMany,
  suppressionFindMany,
  grantFindMany,
  resolveGrantSuppression,
} = vi.hoisted(() => ({
  scholarFindMany: vi.fn(),
  divisionFindMany: vi.fn(),
  divisionMembershipFindMany: vi.fn(),
  authorFindMany: vi.fn(),
  suppressionFindMany: vi.fn(),
  grantFindMany: vi.fn(),
  resolveGrantSuppression: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: scholarFindMany },
    division: { findMany: divisionFindMany },
    divisionMembership: { findMany: divisionMembershipFindMany },
    publicationAuthor: { findMany: authorFindMany },
    suppression: { findMany: suppressionFindMany },
    grant: { findMany: grantFindMany },
  },
}));

// Only the grant-suppression resolver is stubbed; the publication-suppression
// loaders run for real against the mocked `suppression` table.
vi.mock("@/lib/api/manual-layer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/manual-layer")>()),
  resolveActiveGrantSuppression: resolveGrantSuppression,
}));

import { HIDDEN_ROLE_CATEGORIES } from "@/lib/eligibility";
import {
  buildDepartmentCollaboration,
  isDepartmentCollaborationEligible,
  NO_DIVISION_LABEL,
} from "@/lib/api/department-collaboration";
import { EXTENDED_GROUP_PALETTE, UNCLASSIFIED_COLOR } from "@/lib/center-collaboration/graph";

const DEPT = { code: "TSTDEPT" };

function scholar(
  cwid: string,
  name: string,
  divCode: string | null,
  roleCategory: string | null = "full_time_faculty",
) {
  return { cwid, preferredName: name, slug: `slug-${cwid}`, roleCategory, divCode };
}

function authorship(pmid: string, cwid: string, year = 2024) {
  return { pmid, cwid, publication: { year } };
}

beforeEach(() => {
  vi.clearAllMocks();
  scholarFindMany.mockResolvedValue([]);
  divisionFindMany.mockResolvedValue([]);
  divisionMembershipFindMany.mockResolvedValue([]);
  authorFindMany.mockResolvedValue([]);
  suppressionFindMany.mockResolvedValue([]);
  grantFindMany.mockResolvedValue([]);
  resolveGrantSuppression.mockResolvedValue({ suppressed: new Set(), unsuppressedKeyCount: 0 });
});

describe("isDepartmentCollaborationEligible", () => {
  it("needs ≥2 divisions with ≥1 public member", () => {
    expect(isDepartmentCollaborationEligible(new Map())).toBe(false);
    expect(isDepartmentCollaborationEligible(new Map([["A", 5]]))).toBe(false);
    expect(isDepartmentCollaborationEligible(new Map([["A", 5], ["B", 0]]))).toBe(false);
    expect(isDepartmentCollaborationEligible(new Map([["A", 5], ["B", 1]]))).toBe(true);
  });
});

describe("buildDepartmentCollaboration — public gate", () => {
  it("scopes both the member and authorship reads to the department's public gate", async () => {
    await buildDepartmentCollaboration(DEPT);
    const where = scholarFindMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.deptCode).toBe("TSTDEPT");
    expect(where.deletedAt).toBeNull();
    expect(where.status).toBe("active");
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toContainEqual({ roleCategory: null });
    expect(or).toContainEqual({ roleCategory: { notIn: [...HIDDEN_ROLE_CATEGORIES] } });
  });

  it("returns an empty payload when no member passes the gate", async () => {
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.nodes).toEqual([]);
    expect(payload.papers).toEqual([]);
    expect(authorFindMany).not.toHaveBeenCalled();
  });

  it("drops hidden-role members from nodes AND every paper, keeping indices aligned", async () => {
    scholarFindMany.mockResolvedValue([
      scholar("tst0001", "Ada Alpha", "DIV_A"),
      // Passes the SQL denylist (suffixed) but not the fail-closed predicate.
      scholar("tst0002", "Bo Beta", "DIV_A", "doctoral_student_dvm"),
      scholar("tst0003", "Cy Gamma", "DIV_A", HIDDEN_ROLE_CATEGORIES[0]),
      scholar("tst0004", "Di Delta", "DIV_A"),
    ]);
    divisionFindMany.mockResolvedValue([{ code: "DIV_A", name: "Alpha Division", source: "ED" }]);
    authorFindMany.mockResolvedValue([
      authorship("100", "tst0001"),
      authorship("100", "tst0002"),
      authorship("200", "tst0002"),
      authorship("200", "tst0003"),
      authorship("300", "tst0001"),
      authorship("300", "tst0004"),
    ]);

    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.nodes.map((n) => n.cwid)).toEqual(["tst0001", "tst0004"]);
    expect(payload.nodes.map((n) => n.i)).toEqual([0, 1]);
    // 100 lost its hidden co-author (now 1 member), 200 had only hidden members.
    expect(payload.papers).toEqual([{ pmid: "300", year: 2024, m: [0, 1] }]);
  });
});

describe("buildDepartmentCollaboration — division grouping + legend", () => {
  it("LDAP divCode wins; manual-only gets the first manual division by name; else No division", async () => {
    scholarFindMany.mockResolvedValue([
      scholar("tst0001", "Ada Alpha", "DIV_A"),
      scholar("tst0002", "Bo Beta", null), // manual in two divisions
      scholar("tst0003", "Cy Gamma", "OTHER_DEPT_DIV"), // not this department's
      scholar("tst0004", "Di Delta", null),
      scholar("tst0005", "Ed Epsilon", "DIV_A"),
    ]);
    divisionFindMany.mockResolvedValue([
      { code: "DIV_A", name: "Alpha Division", source: "ED" },
      { code: "MAN_Z", name: "Zeta Division", source: "manual" },
      { code: "MAN_M", name: "Mu Division", source: "manual" },
    ]);
    divisionMembershipFindMany.mockResolvedValue([
      { divisionCode: "MAN_Z", cwid: "tst0002" },
      { divisionCode: "MAN_M", cwid: "tst0002" },
      // tst0001's LDAP division beats a manual listing.
      { divisionCode: "MAN_Z", cwid: "tst0001" },
    ]);

    const payload = await buildDepartmentCollaboration(DEPT);
    const groupOf = Object.fromEntries(payload.nodes.map((n) => [n.cwid, n.programCode]));
    expect(groupOf).toEqual({
      tst0001: "DIV_A",
      tst0002: "MAN_M", // "Mu" < "Zeta"
      tst0003: null,
      tst0004: null,
      tst0005: "DIV_A",
    });
    // The manual roster read is bounded to manual divisions + gated members.
    const mWhere = divisionMembershipFindMany.mock.calls[0][0].where;
    expect(mWhere.divisionCode.in.sort()).toEqual(["MAN_M", "MAN_Z"]);
    expect(mWhere.cwid.in).toHaveLength(5);

    // Legend: only divisions with nodes, biggest first, then "No division" (gray).
    expect(payload.programs.map((p) => [p.code, p.label])).toEqual([
      ["DIV_A", "Alpha Division"],
      ["MAN_M", "Mu Division"],
      [null, NO_DIVISION_LABEL],
    ]);
    expect(payload.programs[2].color).toBe(UNCLASSIFIED_COLOR);
  });

  it("skips the manual roster read when no division is manual", async () => {
    scholarFindMany.mockResolvedValue([scholar("tst0001", "Ada Alpha", "DIV_A")]);
    divisionFindMany.mockResolvedValue([{ code: "DIV_A", name: "Alpha Division", source: "ED" }]);
    await buildDepartmentCollaboration(DEPT);
    expect(divisionMembershipFindMany).not.toHaveBeenCalled();
  });

  it("colours >6 divisions from the extended palette with no duplicates, ordered by member count", async () => {
    const divisions = Array.from({ length: 9 }, (_, d) => ({
      code: `D${d}`,
      name: `Division ${d}`,
      source: "ED",
    }));
    // Division d gets d+1 members, so D8 is the largest.
    const members = divisions.flatMap((div, d) =>
      Array.from({ length: d + 1 }, (_, k) =>
        scholar(`tst${d}${k}`.padEnd(7, "0"), `Person ${d}-${k}`, div.code),
      ),
    );
    scholarFindMany.mockResolvedValue(members);
    divisionFindMany.mockResolvedValue(divisions);

    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.programs.map((p) => p.code)).toEqual(
      ["D8", "D7", "D6", "D5", "D4", "D3", "D2", "D1", "D0"],
    );
    const colors = payload.programs.map((p) => p.color);
    expect(new Set(colors).size).toBe(9);
    expect(colors).toEqual(EXTENDED_GROUP_PALETTE.slice(0, 9));
  });
});

describe("buildDepartmentCollaboration — papers + suppression", () => {
  beforeEach(() => {
    scholarFindMany.mockResolvedValue([
      scholar("tst0001", "Ada Alpha", "DIV_A"),
      scholar("tst0002", "Bo Beta", "DIV_A"),
      scholar("tst0003", "Cy Gamma", "DIV_B"),
    ]);
    divisionFindMany.mockResolvedValue([
      { code: "DIV_A", name: "Alpha Division", source: "ED" },
      { code: "DIV_B", name: "Beta Division", source: "ED" },
    ]);
  });

  it("drops a paper with only one gated member and counts pubs per member", async () => {
    authorFindMany.mockResolvedValue([
      authorship("100", "tst0001"),
      authorship("100", "tst0002"),
      authorship("200", "tst0001"),
      authorship("300", "tst0001"),
      authorship("300", "not-a-member"),
    ]);
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.papers).toEqual([{ pmid: "100", year: 2024, m: [0, 1] }]);
    expect(payload.nodes[0].pubCount).toBe(3);
    // One read of the (tiny) active suppression set — no pmid IN list, which
    // would run to 100k pmids for a large department.
    expect(suppressionFindMany).toHaveBeenCalledTimes(1);
    expect(suppressionFindMany.mock.calls[0][0].where).toEqual({
      entityType: "publication",
      revokedAt: null,
    });
  });

  it("a dark single-author pmid (no department co-author) leaves that member's pubCount", async () => {
    authorFindMany.mockResolvedValue([
      authorship("100", "tst0001"),
      authorship("100", "tst0002"),
      authorship("200", "tst0001"),
      authorship("300", "tst0001"),
    ]);
    suppressionFindMany.mockResolvedValue([
      { entityId: "300", contributorCwid: null },
      // Not a department pmid — ignored, no derived-dark read.
      { entityId: "999", contributorCwid: "tst0002" },
    ]);
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.papers.map((p) => p.pmid)).toEqual(["100"]);
    expect(payload.nodes.map((n) => n.pubCount)).toEqual([2, 1, 0]);
    expect(authorFindMany).toHaveBeenCalledTimes(1);
  });

  it("a per-author hide on a single-author pmid drops it from that member's pubCount", async () => {
    authorFindMany
      .mockResolvedValueOnce([
        authorship("100", "tst0001"),
        authorship("100", "tst0002"),
        authorship("200", "tst0003"),
      ])
      // derived-dark read: tst0003 is 200's only visible author → dark.
      .mockResolvedValueOnce([{ pmid: "200", cwid: "tst0003" }]);
    suppressionFindMany.mockResolvedValue([{ entityId: "200", contributorCwid: "tst0003" }]);
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.nodes.find((n) => n.cwid === "tst0003")!.pubCount).toBe(0);
    expect(payload.nodes.find((n) => n.cwid === "tst0001")!.pubCount).toBe(1);
  });

  it("a dark pmid is dropped from papers AND pubCount", async () => {
    authorFindMany.mockResolvedValue([
      authorship("100", "tst0001"),
      authorship("100", "tst0002"),
      authorship("200", "tst0001"),
      authorship("200", "tst0003"),
    ]);
    suppressionFindMany.mockResolvedValue([{ entityId: "200", contributorCwid: null }]);
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.papers.map((p) => p.pmid)).toEqual(["100"]);
    expect(payload.nodes.map((n) => n.pubCount)).toEqual([1, 1, 0]);
  });

  it("a per-author hide removes only that member, which can drop a 2-member paper", async () => {
    authorFindMany
      .mockResolvedValueOnce([
        authorship("100", "tst0001"),
        authorship("100", "tst0002"),
        authorship("100", "tst0003"),
        authorship("200", "tst0001"),
        authorship("200", "tst0003"),
      ])
      // resolveDarkPmids' derived-dark read: other visible authors remain, so
      // neither pmid is derived-dark.
      .mockResolvedValueOnce([
        { pmid: "100", cwid: "tst0001" },
        { pmid: "100", cwid: "tst0003" },
        { pmid: "200", cwid: "tst0001" },
        { pmid: "200", cwid: "tst0003" },
      ]);
    suppressionFindMany.mockResolvedValue([
      { entityId: "100", contributorCwid: "tst0003" },
      { entityId: "200", contributorCwid: "tst0003" },
    ]);
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.papers).toEqual([{ pmid: "100", year: 2024, m: [0, 1] }]);
    expect(payload.nodes.find((n) => n.cwid === "tst0003")!.pubCount).toBe(0);
    expect(payload.nodes.find((n) => n.cwid === "tst0001")!.pubCount).toBe(2);
  });
});

describe("buildDepartmentCollaboration — grant axis", () => {
  beforeEach(() => {
    scholarFindMany.mockResolvedValue([
      scholar("tst0001", "Ada Alpha", "DIV_A"),
      scholar("tst0002", "Bo Beta", "DIV_B"),
    ]);
    divisionFindMany.mockResolvedValue([
      { code: "DIV_A", name: "Alpha Division", source: "ED" },
      { code: "DIV_B", name: "Beta Division", source: "ED" },
    ]);
  });

  const grant = (cwid: string, externalId: string, awardNumber: string) => ({
    cwid,
    externalId,
    id: externalId,
    awardNumber,
    mechanism: "R01",
    startDate: new Date("2022-01-01T00:00:00Z"),
    endDate: new Date("2099-01-01T00:00:00Z"),
  });

  it("is off unless requested — no grant read, empty awards", async () => {
    const payload = await buildDepartmentCollaboration(DEPT);
    expect(payload.grantAxis).toBe(false);
    expect(payload.awards).toEqual([]);
    expect(grantFindMany).not.toHaveBeenCalled();
  });

  it("when on, a shared award forms a group but a suppressed grant never does", async () => {
    grantFindMany.mockResolvedValue([
      grant("tst0001", "G1", "AWD-1"),
      grant("tst0002", "G2", "AWD-1"),
      grant("tst0001", "G3", "AWD-2"),
      grant("tst0002", "G4", "AWD-2"),
    ]);
    resolveGrantSuppression.mockResolvedValue({
      suppressed: new Set(["G4"]),
      unsuppressedKeyCount: 3,
    });
    const payload = await buildDepartmentCollaboration(DEPT, { includeGrantAxis: true });
    expect(payload.grantAxis).toBe(true);
    expect(payload.awards.map((a) => [a.awardId, a.m])).toEqual([["AWD-1", [0, 1]]]);
  });
});
