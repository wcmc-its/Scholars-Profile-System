/**
 * `lib/edit/manageable-units.ts` (#753) — the "Units you manage" enumeration
 * behind the `/edit` Home card + `/edit/units` index.
 *
 * Covers: grouping + href shape, owner>curator dedup, non-org-unit grants
 * filtered out, stale grants (unit row gone) dropped, name-sorting, the
 * no-grants short-circuit (no name lookups), and the superuser finder list.
 */
import { describe, expect, it, vi } from "vitest";

import {
  loadAllUnitsDirectory,
  loadAllUnitsForFinder,
  loadManageableUnits,
  unitEditHref,
  unitKindLabel,
} from "@/lib/edit/manageable-units";

type Row = { code: string; name: string };
type Grant = { entityType: string; entityId: string; role: "owner" | "curator" };

function selectByCode(
  rows: Row[],
  args: { where?: { code?: { in?: string[] } } } | undefined,
): Row[] {
  const inList = args?.where?.code?.in;
  const pool = inList ? rows.filter((r) => inList.includes(r.code)) : rows;
  return pool.map((r) => ({ code: r.code, name: r.name }));
}

function makeClient(opts: {
  grants?: Grant[];
  departments?: Row[];
  divisions?: Row[];
  centers?: Row[];
}) {
  const dept = vi.fn(async (args?: never) => selectByCode(opts.departments ?? [], args));
  const div = vi.fn(async (args?: never) => selectByCode(opts.divisions ?? [], args));
  const ctr = vi.fn(async (args?: never) => selectByCode(opts.centers ?? [], args));
  const grants = vi.fn(async () => (opts.grants ?? []).map((g) => ({ ...g })));
  return {
    client: {
      unitAdmin: { findMany: grants },
      department: { findMany: dept },
      division: { findMany: div },
      center: { findMany: ctr },
    } as never,
    spies: { grants, dept, div, ctr },
  };
}

describe("unitEditHref / unitKindLabel", () => {
  it("builds an encoded editor route per kind", () => {
    expect(unitEditHref("department", "N1280")).toBe("/edit/department/N1280");
    expect(unitEditHref("division", "N12/34")).toBe("/edit/division/N12%2F34");
    expect(unitEditHref("center", "man-abc123")).toBe("/edit/center/man-abc123");
  });
  it("labels each kind", () => {
    expect(unitKindLabel("department")).toBe("Department");
    expect(unitKindLabel("division")).toBe("Division");
    expect(unitKindLabel("center")).toBe("Center");
  });
});

describe("loadManageableUnits", () => {
  it("returns all-empty and skips name lookups when there are no grants", async () => {
    const { client, spies } = makeClient({ grants: [] });
    const result = await loadManageableUnits("cwid1", client);
    expect(result).toEqual({ departments: [], divisions: [], centers: [], total: 0 });
    expect(spies.dept).not.toHaveBeenCalled();
    expect(spies.div).not.toHaveBeenCalled();
    expect(spies.ctr).not.toHaveBeenCalled();
  });

  it("groups grants by kind, resolves names, and builds hrefs", async () => {
    const { client } = makeClient({
      grants: [
        { entityType: "department", entityId: "N1280", role: "owner" },
        { entityType: "division", entityId: "D-CARD", role: "curator" },
        { entityType: "center", entityId: "man-onc", role: "owner" },
      ],
      departments: [{ code: "N1280", name: "Medicine" }],
      divisions: [{ code: "D-CARD", name: "Cardiology" }],
      centers: [{ code: "man-onc", name: "Cancer Center" }],
    });
    const r = await loadManageableUnits("cwid1", client);
    expect(r.total).toBe(3);
    expect(r.departments).toEqual([
      {
        kind: "department",
        code: "N1280",
        name: "Medicine",
        role: "owner",
        href: "/edit/department/N1280",
      },
    ]);
    expect(r.divisions).toEqual([
      {
        kind: "division",
        code: "D-CARD",
        name: "Cardiology",
        role: "curator",
        href: "/edit/division/D-CARD",
      },
    ]);
    expect(r.centers).toEqual([
      {
        kind: "center",
        code: "man-onc",
        name: "Cancer Center",
        role: "owner",
        href: "/edit/center/man-onc",
      },
    ]);
  });

  it("dedupes a unit granted twice, keeping owner over curator", async () => {
    const { client } = makeClient({
      grants: [
        { entityType: "department", entityId: "N1280", role: "curator" },
        { entityType: "department", entityId: "N1280", role: "owner" },
      ],
      departments: [{ code: "N1280", name: "Medicine" }],
    });
    const r = await loadManageableUnits("cwid1", client);
    expect(r.departments).toHaveLength(1);
    expect(r.departments[0].role).toBe("owner");
    expect(r.total).toBe(1);
  });

  it("ignores non-org-unit grants (e.g. scholar/mentee)", async () => {
    const { client } = makeClient({
      grants: [
        { entityType: "scholar", entityId: "abc", role: "owner" } as Grant,
        { entityType: "department", entityId: "N1280", role: "owner" },
      ],
      departments: [{ code: "N1280", name: "Medicine" }],
    });
    const r = await loadManageableUnits("cwid1", client);
    expect(r.total).toBe(1);
    expect(r.departments[0].code).toBe("N1280");
  });

  it("drops a grant whose unit row no longer exists", async () => {
    const { client } = makeClient({
      grants: [
        { entityType: "center", entityId: "man-live", role: "owner" },
        { entityType: "center", entityId: "man-gone", role: "owner" },
      ],
      centers: [{ code: "man-live", name: "Live Center" }], // man-gone absent
    });
    const r = await loadManageableUnits("cwid1", client);
    expect(r.centers.map((c) => c.code)).toEqual(["man-live"]);
    expect(r.total).toBe(1);
  });

  it("sorts each group by name", async () => {
    const { client } = makeClient({
      grants: [
        { entityType: "department", entityId: "N2", role: "owner" },
        { entityType: "department", entityId: "N1", role: "owner" },
      ],
      departments: [
        { code: "N2", name: "Surgery" },
        { code: "N1", name: "Anesthesiology" },
      ],
    });
    const r = await loadManageableUnits("cwid1", client);
    expect(r.departments.map((d) => d.name)).toEqual(["Anesthesiology", "Surgery"]);
  });
});

describe("loadAllUnitsForFinder", () => {
  it("returns every unit across kinds, name-sorted, with hrefs", async () => {
    const { client } = makeClient({
      departments: [{ code: "N1", name: "Medicine" }],
      divisions: [{ code: "D1", name: "Cardiology" }],
      centers: [{ code: "C1", name: "Brain Center" }],
    });
    const list = await loadAllUnitsForFinder(client);
    expect(list.map((u) => u.name)).toEqual(["Brain Center", "Cardiology", "Medicine"]);
    expect(list.find((u) => u.code === "D1")).toMatchObject({
      kind: "division",
      href: "/edit/division/D1",
    });
  });
});

// --- #971 directory loader --------------------------------------------------

type DeptRow = {
  code: string;
  name: string;
  slug?: string;
  description?: string | null;
  officialName?: string | null;
  compactName?: string | null;
  category?: string;
  chairCwid?: string | null;
  scholarCount?: number;
  source?: string;
};
type DivRow = {
  code: string;
  name: string;
  slug?: string;
  description?: string | null;
  chiefCwid?: string | null;
  scholarCount?: number;
  source?: string;
  deptCode?: string;
  department?: { name: string } | null;
};
type CtrRow = {
  code: string;
  name: string;
  slug?: string;
  description?: string | null;
  officialName?: string | null;
  compactName?: string | null;
  centerType?: string;
  directorCwid?: string | null;
  leaderInterim?: boolean;
  scholarCount?: number;
  sortOrder?: number;
  source?: string;
};
type Suppr = { entityType: string; entityId: string };
type ScholarRow = { cwid: string; preferredName: string };
type MembershipRow = {
  centerCode: string;
  cwid: string;
  startDate?: Date | null;
  endDate?: Date | null;
};

function makeDirectoryClient(opts: {
  departments?: DeptRow[];
  divisions?: DivRow[];
  centers?: CtrRow[];
  suppressions?: Suppr[];
  scholars?: ScholarRow[];
  /** Center roster rows — centers count live off these, never off the row. */
  memberships?: MembershipRow[];
}) {
  const dept = vi.fn(async () => opts.departments ?? []);
  const div = vi.fn(async () => opts.divisions ?? []);
  const ctr = vi.fn(async () => opts.centers ?? []);
  const suppression = vi.fn(async () => opts.suppressions ?? []);
  const scholar = vi.fn(async (args?: { where?: { cwid?: { in?: string[] } } }) => {
    const inList = args?.where?.cwid?.in ?? [];
    return (opts.scholars ?? []).filter((s) => inList.includes(s.cwid));
  });
  const centerMembership = vi.fn(
    async (args?: { where?: { centerCode?: { in?: string[] } } }) => {
      const inList = args?.where?.centerCode?.in ?? [];
      return (opts.memberships ?? [])
        .filter((m) => inList.includes(m.centerCode))
        .map((m) => ({ startDate: null, endDate: null, ...m }));
    },
  );
  return {
    client: {
      department: { findMany: dept },
      division: { findMany: div },
      center: { findMany: ctr },
      suppression: { findMany: suppression },
      scholar: { findMany: scholar },
      centerMembership: { findMany: centerMembership },
    } as never,
    spies: { dept, div, ctr, suppression, scholar, centerMembership },
  };
}

describe("loadAllUnitsDirectory", () => {
  it("maps a curated department: official override heading, compact short label", async () => {
    const { client } = makeDirectoryClient({
      departments: [
        {
          code: "N1280",
          name: "Library",
          slug: "library",
          description: "The library.",
          officialName: "Samuel J. Wood Library",
          compactName: "Library",
          category: "administrative",
          chairCwid: "abc1234",
          scholarCount: 5,
          source: "ED",
        },
      ],
      scholars: [{ cwid: "abc1234", preferredName: "Jane Chair" }],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      kind: "department",
      code: "N1280",
      officialName: "Samuel J. Wood Library",
      compactName: "Library",
      category: "administrative",
      centerType: null,
      leaderCwid: "abc1234",
      leaderName: "Jane Chair",
      leaderInterim: false,
      parentDeptCode: null,
      parentDeptName: null,
      sortOrder: null,
      retired: false,
      href: "/edit/department/N1280",
    });
  });

  it("division degrades gracefully: official=compact=name, no category, parent resolved", async () => {
    const { client } = makeDirectoryClient({
      divisions: [
        {
          code: "D-CARD",
          name: "Cardiology",
          slug: "cardiology",
          description: null,
          chiefCwid: null,
          scholarCount: 2,
          source: "ED",
          deptCode: "N1280",
          department: { name: "Medicine" },
        },
      ],
    });
    const r = await loadAllUnitsDirectory(client);
    const div = r.find((u) => u.code === "D-CARD")!;
    expect(div.officialName).toBe("Cardiology");
    expect(div.compactName).toBe("Cardiology");
    expect(div.category).toBeNull();
    expect(div.centerType).toBeNull();
    expect(div.sortOrder).toBeNull();
    expect(div.parentDeptCode).toBe("N1280");
    expect(div.parentDeptName).toBe("Medicine");
  });

  it("center carries centerType/sortOrder/leaderInterim and never a parent dept", async () => {
    const { client } = makeDirectoryClient({
      centers: [
        {
          code: "man-onc",
          name: "Cancer Center",
          slug: "cancer",
          description: "Onc.",
          centerType: "institute",
          directorCwid: "dir9999",
          leaderInterim: true,
          scholarCount: 9,
          sortOrder: 3,
          source: "seed",
        },
      ],
      scholars: [{ cwid: "dir9999", preferredName: "Acting Director" }],
    });
    const r = await loadAllUnitsDirectory(client);
    const ctr = r.find((u) => u.code === "man-onc")!;
    expect(ctr.centerType).toBe("institute");
    expect(ctr.sortOrder).toBe(3);
    expect(ctr.leaderInterim).toBe(true);
    expect(ctr.leaderName).toBe("Acting Director");
    expect(ctr.parentDeptCode).toBeNull();
    expect(ctr.parentDeptName).toBeNull();
  });

  it("leaderName is null (not the bare cwid) when the leader isn't a scholar — gap signal", async () => {
    const { client } = makeDirectoryClient({
      departments: [{ code: "N9", name: "Orphan Dept", chairCwid: "ghost1", scholarCount: 0 }],
      // no matching scholar row for ghost1
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r[0].leaderCwid).toBe("ghost1");
    expect(r[0].leaderName).toBeNull();
  });

  it("external-leader overlay (keyed by unit code) wins with no scholar row", async () => {
    const { client } = makeDirectoryClient({
      // N1540 is Joel Stein in EXTERNAL_LEADERS; jos7021 has no scholar row.
      departments: [
        { code: "N1540", name: "Rehabilitation Medicine", chairCwid: "jos7021", scholarCount: 1 },
      ],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r[0].leaderName).toBe("Joel Stein");
    expect(r[0].leaderCwid).toBe("jos7021");
  });

  it("derives retired from ONE suppression.findMany (not per-unit), hidden by default", async () => {
    const { client, spies } = makeDirectoryClient({
      centers: [
        { code: "live", name: "Live Center", scholarCount: 1 },
        { code: "dead", name: "Dead Center", scholarCount: 0 },
      ],
      suppressions: [{ entityType: "center", entityId: "dead" }],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(spies.suppression).toHaveBeenCalledTimes(1);
    expect(r.map((u) => u.code)).toEqual(["live"]); // dead dropped (default hides retired)
  });

  it("includeRetired keeps and marks retired rows", async () => {
    const { client } = makeDirectoryClient({
      centers: [
        { code: "live", name: "Live Center", scholarCount: 1 },
        { code: "dead", name: "Dead Center", scholarCount: 0 },
      ],
      suppressions: [{ entityType: "center", entityId: "dead" }],
    });
    const r = await loadAllUnitsDirectory(client, { includeRetired: true });
    expect(r.find((u) => u.code === "dead")!.retired).toBe(true);
    expect(r.find((u) => u.code === "live")!.retired).toBe(false);
  });

  it("sorts by kind (dept, division, center) then name", async () => {
    const { client } = makeDirectoryClient({
      departments: [
        { code: "N2", name: "Surgery", scholarCount: 0 },
        { code: "N1", name: "Anesthesiology", scholarCount: 0 },
      ],
      divisions: [{ code: "D1", name: "Cardiology", scholarCount: 0 }],
      centers: [{ code: "C1", name: "Brain Center", scholarCount: 0 }],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r.map((u) => `${u.kind}:${u.name}`)).toEqual([
      "department:Anesthesiology",
      "department:Surgery",
      "division:Cardiology",
      "center:Brain Center",
    ]);
  });

  // The directory must count a center's roster live. `Center.scholarCount`
  // is never maintained (the ED ETL's Phase 3 refresh does departments and
  // divisions only), so reading it reported "0 scholars" for every manually
  // created center while its public page showed the real number. This fails if
  // anyone reverts the center branch to `r.scholarCount`.
  it("counts a center's members live, ignoring the stale scholarCount column", async () => {
    const { client } = makeDirectoryClient({
      centers: [{ code: "friedman_nutrition", name: "Friedman Center", scholarCount: 0 }],
      memberships: [
        { centerCode: "friedman_nutrition", cwid: "aaa1001" },
        { centerCode: "friedman_nutrition", cwid: "bbb1002" },
        { centerCode: "friedman_nutrition", cwid: "ccc1003" },
      ],
      scholars: [
        { cwid: "aaa1001", preferredName: "A" },
        { cwid: "bbb1002", preferredName: "B" },
        { cwid: "ccc1003", preferredName: "C" },
      ],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r[0].scholarCount).toBe(3);
  });

  it("does not let a non-zero stale column leak through for a center with no roster", async () => {
    const { client } = makeDirectoryClient({
      centers: [{ code: "C1", name: "Empty Center", scholarCount: 999 }],
    });
    const r = await loadAllUnitsDirectory(client);
    expect(r[0].scholarCount).toBe(0);
  });
});
