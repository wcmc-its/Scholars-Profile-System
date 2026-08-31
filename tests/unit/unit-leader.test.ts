/**
 * `lib/api/unit-leader.ts` — Phase D foundation (#2542 follow-on).
 *
 * Covers the override-over-assignment-over-column precedence. The last
 * `describe` block is the regression test that matters: a `field_override`
 * `leaderCwid` row must win over BOTH the assignment table and the legacy
 * column, because the ETL only rewrites the column once a night while the
 * override applies on read immediately — see the module docblock.
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
      legacyLeaderCwid: "col999", // must be ignored — assignment wins
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

  it("falls back to the legacy column when no assignment row exists", async () => {
    const client = makeClient({
      roles: [{ entityType: "division", key: "chief", label: "Chief" }],
    });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-1",
      roleKey: "chief",
      legacyLeaderCwid: "col123",
      overrides: NO_OVERRIDES,
      fallbackLabel: "Chief",
      client,
    });
    expect(result).toEqual({
      cwid: "col123",
      interim: false,
      roleKey: "chief",
      roleLabel: "Chief",
      source: "column",
    });
  });

  it("returns null when there is no override, no assignment, and no column value", async () => {
    const client = makeClient({});
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      legacyLeaderCwid: null,
      overrides: NO_OVERRIDES,
      fallbackLabel: "Chair",
      client,
    });
    expect(result).toBeNull();
  });

  it("labels from the vocabulary even on the column branch — a curator rename is honored pre-backfill", async () => {
    const client = makeClient({
      roles: [{ entityType: "department", key: "chair", label: "Department Head" }],
    });
    const result = await resolveUnitLeader({
      entityType: "department",
      entityId: "DEPT-X",
      roleKey: "chair",
      legacyLeaderCwid: "col123",
      overrides: NO_OVERRIDES,
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
      legacyLeaderCwid: "col123",
      overrides: NO_OVERRIDES,
      fallbackLabel: "Chief",
      client,
    });
    expect(result?.roleLabel).toBe("Chief");
  });
});

describe("resolveUnitLeader — field_override present (the regression test that matters)", () => {
  it("a field_override leaderCwid beats BOTH the assignment table and the legacy column", async () => {
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
      legacyLeaderCwid: "stale-column", // must ALSO be ignored
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
    // Neither downstream store should even be queried once an override fires.
    expect(client.orgUnitRoleAssignment.findFirst).not.toHaveBeenCalled();
  });

  it("an override wins even when the legacy column also disagrees and there is no assignment at all", async () => {
    const client = makeClient({ roles: [{ entityType: "division", key: "chief", label: "Chief" }] });
    const result = await resolveUnitLeader({
      entityType: "division",
      entityId: "DIV-1",
      roleKey: "chief",
      legacyLeaderCwid: "stale-column",
      overrides: { leaderCwid: "curator-pick", leaderInterim: "true" },
      fallbackLabel: "Chief",
      client,
    });
    expect(result).toMatchObject({ cwid: "curator-pick", interim: true, source: "override" });
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
      legacyLeaderCwid: "would-also-render",
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
      legacyLeaderCwid: null,
      overrides: { leaderCwid: "curator-pick", leaderInterim: "maybe" },
      fallbackLabel: "Chair",
      client,
    });
    expect(result?.interim).toBe(false);
  });
});
