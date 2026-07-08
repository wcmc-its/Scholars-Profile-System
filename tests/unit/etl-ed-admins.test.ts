/**
 * #728 — pure-logic tests for the ED admin-role importer: grant building (with
 * skip-and-log of unmapped codes + multi-tag collapse) and the per-source
 * reconcile delete-set. The DB/LDAP I/O paths are not exercised here.
 */
import { describe, expect, it } from "vitest";

import {
  buildEdAdminGrants,
  collectTaggedCwids,
  filterUnitsByActiveMembers,
  grantKey,
  isManualOwnerProtected,
  selectStaleRows,
  type ResolvedUnit,
} from "@/etl/ed-admins/index";
import type { EdOrgUnitAdmins } from "@/lib/sources/ldap";

/** Build a unit fixture; absent tags default to []. */
function unit(
  code: string,
  tags: Partial<Record<"da" | "diva" | "iamdela" | "diva-iamdela", string[]>>,
): EdOrgUnitAdmins {
  return {
    code,
    displayName: code,
    unitType: "department",
    level: 1,
    byTag: {
      da: tags.da ?? [],
      diva: tags.diva ?? [],
      iamdela: tags.iamdela ?? [],
      "diva-iamdela": tags["diva-iamdela"] ?? [],
    },
  };
}

const resolver = new Map<string, ResolvedUnit>([
  ["N1", { entityType: "department", entityId: "N1" }],
  ["N2", { entityType: "division", entityId: "N2" }],
]);

describe("buildEdAdminGrants", () => {
  it("resolves grants, stamps per-tag source, and skip-and-logs unmapped codes", () => {
    const { grants, seenBySource, skippedNoUnit, unmatchedCodes } = buildEdAdminGrants(
      [
        unit("N1", { da: ["alice"], iamdela: ["bob"] }),
        unit("N2", { diva: ["alice"] }),
        unit("N9", { da: ["carol"] }), // unmapped → skipped
      ],
      resolver,
    );

    expect(grants.get(grantKey("department", "N1", "alice"))).toMatchObject({ source: "ED:DA" });
    expect(grants.get(grantKey("department", "N1", "bob"))).toMatchObject({ source: "ED:IAMDELA" });
    expect(grants.get(grantKey("division", "N2", "alice"))).toMatchObject({ source: "ED:DivA" });
    expect(grants.size).toBe(3);

    expect(seenBySource.get("ED:DA")).toEqual(new Set([grantKey("department", "N1", "alice")]));
    expect(seenBySource.get("ED:DivA")).toEqual(new Set([grantKey("division", "N2", "alice")]));

    expect(skippedNoUnit).toBe(1);
    expect(unmatchedCodes).toEqual(new Set(["N9"]));
  });

  it("stamps role per population: DA + DivA-IAMDELA → owner, DivA + IAMDELA → curator", () => {
    const { grants } = buildEdAdminGrants(
      [unit("N1", { da: ["a"], diva: ["b"], iamdela: ["c"] }), unit("N2", { "diva-iamdela": ["d"] })],
      resolver,
    );
    expect(grants.get(grantKey("department", "N1", "a"))).toMatchObject({ source: "ED:DA", role: "owner" });
    expect(grants.get(grantKey("department", "N1", "b"))).toMatchObject({ source: "ED:DivA", role: "curator" });
    expect(grants.get(grantKey("department", "N1", "c"))).toMatchObject({ source: "ED:IAMDELA", role: "curator" });
    expect(grants.get(grantKey("division", "N2", "d"))).toMatchObject({ source: "ED:DivA-IAMDELA", role: "owner" });
  });

  it("collapses one cwid holding two tags on one unit to a single grant present in BOTH seen sets", () => {
    const { grants, seenBySource } = buildEdAdminGrants(
      [unit("N1", { iamdela: ["dave"], "diva-iamdela": ["dave"] })],
      resolver,
    );

    // Single row (last-population-wins on source: diva-iamdela is last in tag order).
    const key = grantKey("department", "N1", "dave");
    expect(grants.size).toBe(1);
    expect(grants.get(key)?.source).toBe("ED:DivA-IAMDELA");
    expect(grants.get(key)?.role).toBe("owner"); // diva-iamdela wins → owner, not iamdela's curator

    // ...but both populations' reconcile sets include the key, so neither
    // population's reconcile deletes it while it is in the other.
    expect(seenBySource.get("ED:IAMDELA")?.has(key)).toBe(true);
    expect(seenBySource.get("ED:DivA-IAMDELA")?.has(key)).toBe(true);
  });

  it("returns empty structures for no units", () => {
    const { grants, seenBySource, skippedNoUnit } = buildEdAdminGrants([], resolver);
    expect(grants.size).toBe(0);
    expect(seenBySource.size).toBe(0);
    expect(skippedNoUnit).toBe(0);
  });
});

describe("collectTaggedCwids", () => {
  it("returns every tagged CWID across units + tags, deduped and lowercased", () => {
    const cwids = collectTaggedCwids([
      unit("N1", { da: ["Alice", "bob"], iamdela: ["bob"] }),
      unit("N2", { diva: ["ALICE"], "diva-iamdela": ["carol"] }),
    ]);
    expect(new Set(cwids)).toEqual(new Set(["alice", "bob", "carol"]));
    expect(cwids.length).toBe(3);
  });

  it("returns nothing for units with no tagged CWIDs", () => {
    expect(collectTaggedCwids([unit("N1", {})])).toEqual([]);
  });
});

describe("filterUnitsByActiveMembers (active-member guard)", () => {
  it("drops tagged CWIDs whose ED person is not an active member", () => {
    const active = new Map<string, boolean>([
      ["alice", true],
      ["bob", false], // expired person — ED left the tag on
      // "carol" absent from the map → treated as not active
    ]);
    const { units, droppedInactive } = filterUnitsByActiveMembers(
      [unit("N1", { da: ["alice", "bob"], iamdela: ["carol"] })],
      active,
    );
    expect(units[0].byTag.da).toEqual(["alice"]);
    expect(units[0].byTag.iamdela).toEqual([]);
    expect(droppedInactive).toBe(2); // bob + carol
  });

  it("keeps units untouched when every tagged member is active", () => {
    const active = new Map<string, boolean>([["alice", true]]);
    const { units, droppedInactive } = filterUnitsByActiveMembers(
      [unit("N1", { da: ["alice"] })],
      active,
    );
    expect(units[0].byTag.da).toEqual(["alice"]);
    expect(droppedInactive).toBe(0);
  });

  it("an inactive tagged CWID is excluded from BOTH grants and the reconcile `seen` set", () => {
    // Compose the real pipeline: filter → build. The inactive member must not
    // upsert AND must be absent from `seen` so the per-source reconcile deletes
    // its stale UnitAdmin row on this run (self-healing revocation).
    const active = new Map<string, boolean>([
      ["alice", true],
      ["stale", false],
    ]);
    const { units } = filterUnitsByActiveMembers(
      [unit("N1", { da: ["alice", "stale"] })],
      active,
    );
    const { grants, seenBySource } = buildEdAdminGrants(units, resolver);

    expect(grants.has(grantKey("department", "N1", "alice"))).toBe(true);
    expect(grants.has(grantKey("department", "N1", "stale"))).toBe(false);
    // `stale` absent from ED:DA seen → selectStaleRows would flag its DB row.
    const seenDA = seenBySource.get("ED:DA") ?? new Set<string>();
    expect(seenDA.has(grantKey("department", "N1", "alice"))).toBe(true);
    expect(seenDA.has(grantKey("department", "N1", "stale"))).toBe(false);
    expect(
      selectStaleRows(
        [{ entityType: "department", entityId: "N1", cwid: "stale" }],
        seenDA,
      ),
    ).toEqual([{ entityType: "department", entityId: "N1", cwid: "stale" }]);
  });
});

describe("isManualOwnerProtected (MUST-9)", () => {
  it("protects a manual-owner key even when ED now writes an owner for it", () => {
    const g = { entityType: "department", entityId: "N1", cwid: "alice", source: "ED:DA", role: "owner" } as const;
    const manualOwnerKeys = new Set([grantKey("department", "N1", "alice")]);
    // ED would write owner for this exact key — still skipped; the manual owner wins.
    expect(isManualOwnerProtected(g, manualOwnerKeys)).toBe(true);
  });

  it("does not protect keys with no manual owner", () => {
    const g = { entityType: "division", entityId: "N2", cwid: "bob" } as const;
    expect(isManualOwnerProtected(g, new Set([grantKey("department", "N1", "alice")]))).toBe(false);
  });
});

describe("selectStaleRows", () => {
  it("returns DB rows absent from this run's seen set (the reconcile delete-set)", () => {
    const rows = [
      { entityType: "department", entityId: "N1", cwid: "alice" }, // still present
      { entityType: "department", entityId: "N1", cwid: "zoe" }, // left the population
    ];
    const seen = new Set([grantKey("department", "N1", "alice")]);
    expect(selectStaleRows(rows, seen)).toEqual([
      { entityType: "department", entityId: "N1", cwid: "zoe" },
    ]);
  });

  it("returns nothing when every row is still seen", () => {
    const rows = [{ entityType: "division", entityId: "N2", cwid: "alice" }];
    const seen = new Set([grantKey("division", "N2", "alice")]);
    expect(selectStaleRows(rows, seen)).toEqual([]);
  });
});
