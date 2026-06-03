/**
 * `lib/api/administrators-roster.ts` — the Administrators-tab roster loader
 * (#728 Phase B). Pure-ish loader tests against a hand-rolled fake client:
 * grouping by person, scope filtering, provenance passthrough, and the #443
 * name-resolution degradation flag.
 */
import { describe, expect, it } from "vitest";

import {
  loadUnitAdministratorRoster,
  type AdminRosterClient,
} from "@/lib/api/administrators-roster";

type UnitAdminRow = {
  entityType: "department" | "division" | "center";
  entityId: string;
  cwid: string;
  role: "owner" | "curator";
  source: string;
};
type NamedRow = { code: string; name: string };
type ScholarRow = { cwid: string; preferredName: string; primaryTitle: string | null };

/** A minimal in-memory `AdminRosterClient` honoring the `{ in: [...] }` filters. */
function makeClient(data: {
  unitAdmin: UnitAdminRow[];
  departments?: NamedRow[];
  divisions?: NamedRow[];
  centers?: NamedRow[];
  scholars?: ScholarRow[];
}): AdminRosterClient {
  const inFilter = <T extends { code: string }>(rows: T[], codes: string[] | undefined) =>
    codes ? rows.filter((r) => codes.includes(r.code)) : rows;
  return {
    unitAdmin: {
      findMany: async (args: { where: { entityId?: { in: string[] } } }) => {
        const inScope = args.where?.entityId?.in;
        const rows = inScope
          ? data.unitAdmin.filter((r) => inScope.includes(r.entityId))
          : data.unitAdmin;
        return rows.map((r) => ({ ...r }));
      },
    },
    department: {
      findMany: async (args: { where: { code: { in: string[] } } }) =>
        inFilter(data.departments ?? [], args.where.code.in).map((r) => ({ ...r })),
    },
    division: {
      findMany: async (args: { where: { code: { in: string[] } } }) =>
        inFilter(data.divisions ?? [], args.where.code.in).map((r) => ({ ...r })),
    },
    center: {
      findMany: async (args: { where: { code: { in: string[] } } }) =>
        inFilter(data.centers ?? [], args.where.code.in).map((r) => ({ ...r })),
    },
    scholar: {
      findMany: async (args: { where: { cwid: { in: string[] } } }) =>
        (data.scholars ?? [])
          .filter((s) => args.where.cwid.in.includes(s.cwid))
          .map((s) => ({ ...s })),
    },
  } as unknown as AdminRosterClient;
}

describe("loadUnitAdministratorRoster — grouping", () => {
  it("groups multiple grants under one person, sorted by unit name", async () => {
    const client = makeClient({
      unitAdmin: [
        { entityType: "division", entityId: "N1280-Z", cwid: "p1", role: "curator", source: "ED:DivA" },
        { entityType: "department", entityId: "N1280", cwid: "p1", role: "owner", source: "manual" },
      ],
      departments: [{ code: "N1280", name: "Medicine" }],
      divisions: [{ code: "N1280-Z", name: "Zebra Division" }],
      scholars: [{ cwid: "p1", preferredName: "Pat One", primaryTitle: "Professor" }],
    });
    const { entries, nameResolutionDegraded } = await loadUnitAdministratorRoster({}, client);
    expect(entries).toHaveLength(1);
    expect(entries[0].cwid).toBe("p1");
    expect(entries[0].name).toBe("Pat One");
    expect(entries[0].title).toBe("Professor");
    expect(entries[0].grants).toHaveLength(2);
    // Sorted by unitName: "Medicine" before "Zebra Division".
    expect(entries[0].grants.map((g) => g.unitName)).toEqual(["Medicine", "Zebra Division"]);
    expect(nameResolutionDegraded).toBe(false);
  });

  it("sorts people by name then cwid", async () => {
    const client = makeClient({
      unitAdmin: [
        { entityType: "department", entityId: "D1", cwid: "zoe", role: "curator", source: "manual" },
        { entityType: "department", entityId: "D1", cwid: "amy", role: "curator", source: "manual" },
      ],
      departments: [{ code: "D1", name: "Dept One" }],
      scholars: [
        { cwid: "zoe", preferredName: "Zoe Z", primaryTitle: null },
        { cwid: "amy", preferredName: "Amy A", primaryTitle: null },
      ],
    });
    const { entries } = await loadUnitAdministratorRoster({}, client);
    expect(entries.map((e) => e.cwid)).toEqual(["amy", "zoe"]);
  });
});

describe("loadUnitAdministratorRoster — scope filter", () => {
  const data = {
    unitAdmin: [
      { entityType: "department" as const, entityId: "IN", cwid: "p1", role: "curator" as const, source: "ED:DA" },
      { entityType: "department" as const, entityId: "OUT", cwid: "p2", role: "curator" as const, source: "ED:DA" },
    ],
    departments: [
      { code: "IN", name: "In Dept" },
      { code: "OUT", name: "Out Dept" },
    ],
    scholars: [
      { cwid: "p1", preferredName: "P One", primaryTitle: null },
      { cwid: "p2", preferredName: "P Two", primaryTitle: null },
    ],
  };

  it("scope undefined → all grants (superuser)", async () => {
    const { entries } = await loadUnitAdministratorRoster({}, makeClient(data));
    expect(entries.map((e) => e.cwid).sort()).toEqual(["p1", "p2"]);
  });

  it("scope array keeps in-scope, drops out-of-scope", async () => {
    const { entries } = await loadUnitAdministratorRoster({ scope: ["IN"] }, makeClient(data));
    expect(entries).toHaveLength(1);
    expect(entries[0].cwid).toBe("p1");
  });

  it("empty scope → no entries", async () => {
    const { entries, nameResolutionDegraded } = await loadUnitAdministratorRoster(
      { scope: [] },
      makeClient(data),
    );
    expect(entries).toHaveLength(0);
    expect(nameResolutionDegraded).toBe(false);
  });
});

describe("loadUnitAdministratorRoster — provenance + name resolution", () => {
  it("passes through the source verbatim", async () => {
    const client = makeClient({
      unitAdmin: [
        { entityType: "center", entityId: "C1", cwid: "p1", role: "curator", source: "ED:IAMDELA" },
      ],
      centers: [{ code: "C1", name: "Center One" }],
      scholars: [{ cwid: "p1", preferredName: "P One", primaryTitle: null }],
    });
    const { entries } = await loadUnitAdministratorRoster({}, client);
    expect(entries[0].grants[0].source).toBe("ED:IAMDELA");
    expect(entries[0].grants[0].entityType).toBe("center");
    expect(entries[0].grants[0].unitName).toBe("Center One");
  });

  it("falls back to the bare cwid and flags degraded when a grantee has no Scholar row", async () => {
    const client = makeClient({
      unitAdmin: [
        { entityType: "department", entityId: "D1", cwid: "staff1", role: "curator", source: "ED:DA" },
        { entityType: "department", entityId: "D1", cwid: "fac1", role: "curator", source: "manual" },
      ],
      departments: [{ code: "D1", name: "Dept One" }],
      // Only fac1 has a Scholar row; staff1 (a DA) does not.
      scholars: [{ cwid: "fac1", preferredName: "Faculty One", primaryTitle: "MD" }],
    });
    const { entries, nameResolutionDegraded } = await loadUnitAdministratorRoster({}, client);
    expect(nameResolutionDegraded).toBe(true);
    const staff = entries.find((e) => e.cwid === "staff1")!;
    expect(staff.name).toBe("staff1");
    expect(staff.nameResolved).toBe(false);
    const fac = entries.find((e) => e.cwid === "fac1")!;
    expect(fac.name).toBe("Faculty One");
    expect(fac.nameResolved).toBe(true);
  });

  it("uses the bare code when a unit row is missing", async () => {
    const client = makeClient({
      unitAdmin: [
        { entityType: "department", entityId: "GONE", cwid: "p1", role: "curator", source: "ED:DA" },
      ],
      departments: [], // unit row deleted/consolidated
      scholars: [{ cwid: "p1", preferredName: "P One", primaryTitle: null }],
    });
    const { entries } = await loadUnitAdministratorRoster({}, client);
    expect(entries[0].grants[0].unitName).toBe("GONE");
  });
});
