/**
 * `lib/api/unit-leader.ts` — #2542 contract A.
 *
 * Covers the override-over-assignment precedence. The second `describe`
 * block is the regression test that matters: a `field_override` `leaderCwid`
 * row must win over the assignment table, because the ETL only rewrites
 * `OrgUnitRoleAssignment` once a night while the override applies on read
 * immediately — see the module docblock.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveUnitLeader, type UnitLeaderReadClient } from "@/lib/api/unit-leader";
import type { UnitFieldOverrides } from "@/lib/api/manual-layer";

type RoleRow = { entityType: string; key: string; label: string };
type AssignmentRow = {
  entityType: string;
  entityId: string;
  roleKey: string;
  cwid: string;
  interim: boolean;
  sortOrder?: number;
};

function makeClient(opts: { roles?: RoleRow[]; assignments?: AssignmentRow[] }): UnitLeaderReadClient {
  const roles = opts.roles ?? [];
  const assignments = opts.assignments ?? [];
  return {
    orgUnitRole: {
      findUnique: vi.fn(async (args: unknown) => {
        const where = (args as { where: { entityType_key: { entityType: string; key: string } } })
          .where.entityType_key;
        const row = roles.find((r) => r.entityType === where.entityType && r.key === where.key);
        return row ? { label: row.label } : null;
      }),
    } as unknown as UnitLeaderReadClient["orgUnitRole"],
    orgUnitRoleAssignment: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: { entityType: string; entityId: string; roleKey: string } })
          .where;
        const matches = assignments
          .filter(
            (a) =>
              a.entityType === where.entityType &&
              a.entityId === where.entityId &&
              a.roleKey === where.roleKey,
          )
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.cwid.localeCompare(b.cwid));
        const first = matches[0];
        if (!first) return null;
        const role = roles.find((r) => r.entityType === first.entityType && r.key === first.roleKey);
        return {
          cwid: first.cwid,
          interim: first.interim,
          role: { label: role?.label ?? "" },
        };
      }),
    } as unknown as UnitLeaderReadClient["orgUnitRoleAssignment"],
  };
}

const NO_OVERRIDES: UnitFieldOverrides = {};

describe("resolveUnitLeader — no override row", () => {
  it("uses the assignment when one exists, labeling from the vocabulary", async () => {
    const client = makeClient({
      roles: [{ entityType: "department", key: "chair", label: "Chair" }],
      assignments: [
        { entityType: "department", entityId: "DEPT-X", roleKey: "chair", cwid: "chr001", interim: false },
      ],
    });
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides: NO_OVERRIDES,
      fallbackLabel: "Chair",
      client,
    });
    expect(result).toEqual({
      cwid: "chr001",
      interim: false,
      roleKey: "chair",
      roleLabel: "Chair",
      source: "assignment",
    });
  });

  it("returns null when there is no override and no assignment", async () => {
    const client = makeClient({});
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides: NO_OVERRIDES,
      fallbackLabel: "Chair",
      client,
    });
    expect(result).toBeNull();
  });
});

describe("resolveUnitLeader — field_override present (the regression test that matters)", () => {
  it("a field_override leaderCwid beats the assignment table", async () => {
    const client = makeClient({
      roles: [{ entityType: "department", key: "chair", label: "Chair" }],
      assignments: [
        // A stale assignment row — the override must win anyway.
        { entityType: "department", entityId: "DEPT-X", roleKey: "chair", cwid: "stale-assign", interim: false },
      ],
    });
    const overrides: UnitFieldOverrides = { leaderCwid: "curator-pick" };
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides,
      fallbackLabel: "Chair",
      client,
    });
    expect(result).toEqual({
      cwid: "curator-pick",
      interim: false,
      roleKey: "chair",
      roleLabel: "Chair",
      source: "override",
    });
    // The assignment table should not even be queried once an override fires.
    expect(client.orgUnitRoleAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("an override wins even when there is no assignment at all", async () => {
    const client = makeClient({ roles: [{ entityType: "division", key: "chief", label: "Chief" }] });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-1",
      roleKey: "chief",
      overrides: { leaderCwid: "curator-pick", leaderInterim: "true" },
      fallbackLabel: "Chief",
      client,
    });
    expect(result).toMatchObject({ cwid: "curator-pick", interim: true, source: "override" });
  });

  it("labels from the vocabulary on the override branch too — a curator rename is honored", async () => {
    const client = makeClient({
      roles: [{ entityType: "department", key: "chair", label: "Department Head" }],
    });
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides: { leaderCwid: "curator-pick" },
      fallbackLabel: "Chair",
      client,
    });
    expect(result?.roleLabel).toBe("Department Head");
  });

  it("uses fallbackLabel when the vocabulary row is missing", async () => {
    const client = makeClient({ roles: [] });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-1",
      roleKey: "chief",
      overrides: { leaderCwid: "curator-pick" },
      fallbackLabel: "Chief",
      client,
    });
    expect(result?.roleLabel).toBe("Chief");
  });

  it("`leaderCwid: \"\"` is an explicit vacancy — renders no leader, does not fall through", async () => {
    const client = makeClient({
      roles: [{ entityType: "department", key: "chair", label: "Chair" }],
      assignments: [
        { entityType: "department", entityId: "DEPT-X", roleKey: "chair", cwid: "would-render", interim: false },
      ],
    });
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides: { leaderCwid: "" },
      fallbackLabel: "Chair",
      client,
    });
    expect(result).toBeNull();
    expect(client.orgUnitRoleAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("a malformed leaderInterim override renders as not-interim — dept/div has no column to fall back to", async () => {
    const client = makeClient({ roles: [{ entityType: "department", key: "chair", label: "Chair" }] });
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      overrides: { leaderCwid: "curator-pick", leaderInterim: "maybe" },
      fallbackLabel: "Chair",
      client,
    });
    expect(result?.interim).toBe(false);
  });
  // The two prod interim cases are NOT the same shape. Systems and Computational
  // Biomedicine carries BOTH a leaderCwid and a leaderInterim override, so it resolves
  // through the override branch above. Hematology and Medical Oncology carries
  // leaderInterim with NO leaderCwid override, so it resolves through the ASSIGNMENT
  // branch with the interim flag layered on separately -- and as of 2026-08-31 that is
  // the only live instance of this shape in either environment. The test below is the
  // sole coverage for that shape: moving `interimOverride` inside the override branch
  // would keep the suite green and silently drop "Interim" from that division.
  it("a leaderInterim override with NO leaderCwid override still applies over an assignment row", async () => {
    const client = makeClient({
      roles: [{ entityType: "division", key: "chief", label: "Chief" }],
      assignments: [
        { entityType: "division", entityId: "DIV-1", roleKey: "chief", cwid: "assigned", interim: false },
      ],
    });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-1",
      roleKey: "chief",
      overrides: { leaderInterim: "true" },
      fallbackLabel: "Chief",
      client,
    });
    // The cwid still comes from the assignment -- the override is about the FIELD, not
    // about which store produced the holder.
    expect(result).toMatchObject({ cwid: "assigned", interim: true, source: "assignment" });
  });

  it("`leaderInterim: \"false\"` overrides an assignment row that says interim -- not merely truthy-OR", async () => {
    const client = makeClient({
      roles: [{ entityType: "division", key: "chief", label: "Chief" }],
      assignments: [
        { entityType: "division", entityId: "DIV-2", roleKey: "chief", cwid: "assigned", interim: true },
      ],
    });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-2",
      roleKey: "chief",
      overrides: { leaderInterim: "false" },
      fallbackLabel: "Chief",
      client,
    });
    // `interimOverride ?? assignment.interim`. Written as `||` this returns true and the
    // curator's explicit "not interim" is silently discarded -- which the test above
    // would NOT catch.
    expect(result?.interim).toBe(false);
  });
});
