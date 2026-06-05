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
