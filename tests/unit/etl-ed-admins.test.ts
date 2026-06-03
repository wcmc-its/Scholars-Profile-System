/**
 * #728 — pure-logic tests for the ED admin-role importer: grant building (with
 * skip-and-log of unmapped codes + multi-tag collapse) and the per-source
 * reconcile delete-set. The DB/LDAP I/O paths are not exercised here.
 */
import { describe, expect, it } from "vitest";

import { buildEdAdminGrants, grantKey, selectStaleRows, type ResolvedUnit } from "@/etl/ed-admins/index";
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

  it("collapses one cwid holding two tags on one unit to a single grant present in BOTH seen sets", () => {
    const { grants, seenBySource } = buildEdAdminGrants(
      [unit("N1", { iamdela: ["dave"], "diva-iamdela": ["dave"] })],
      resolver,
    );

    // Single row (last-population-wins on source: diva-iamdela is last in tag order).
    const key = grantKey("department", "N1", "dave");
    expect(grants.size).toBe(1);
    expect(grants.get(key)?.source).toBe("ED:DivA-IAMDELA");

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
