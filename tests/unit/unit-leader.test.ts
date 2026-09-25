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

import {
  resolveUnitLeader,
  resolveUnitLeaderCwids,
  type UnitLeaderCwidReadClient,
  type UnitLeaderReadClient,
} from "@/lib/api/unit-leader";
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

type OrderBy = Array<Record<string, "asc" | "desc">>;

/**
 * Sort fixture rows by the `orderBy` the code under test PASSES (not a
 * hard-coded order), so a changed orderBy changes which row comes first.
 * A missing `sortOrder` reads as the column default, 0.
 */
function sortByOrderBy<T extends AssignmentRow>(rows: T[], orderBy: OrderBy | undefined): T[] {
  const keys = (orderBy ?? []).map((o) => Object.entries(o)[0] as [keyof AssignmentRow, "asc" | "desc"]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k] ?? 0;
      const bv = b[k] ?? 0;
      const c =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      if (c !== 0) return dir === "asc" ? c : -c;
    }
    return 0;
  });
}

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
        const { where, orderBy } = args as {
          where: { entityType: string; entityId: string; roleKey: string };
          orderBy?: OrderBy;
        };
        const matches = sortByOrderBy(
          assignments.filter(
            (a) =>
              a.entityType === where.entityType &&
              a.entityId === where.entityId &&
              a.roleKey === where.roleKey,
          ),
          orderBy,
        );
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

describe("resolveUnitLeaderCwids — batched, same cwid as resolveUnitLeader per unit", () => {
  type OverrideRow = { entityType: string; entityId: string; fieldName: string; value: string };

  /** A batch client over the same fixture rows `makeClient` serves one unit at a time. */
  function makeBatchClient(opts: {
    assignments: AssignmentRow[];
    overrides: OverrideRow[];
  }): UnitLeaderCwidReadClient & { calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      fieldOverride: {
        findMany: vi.fn(async (args: unknown) => {
          calls++;
          const where = (
            args as { where: { entityType: string; entityId: { in: string[] }; fieldName: string } }
          ).where;
          return opts.overrides
            .filter(
              (o) =>
                o.entityType === where.entityType &&
                where.entityId.in.includes(o.entityId) &&
                o.fieldName === where.fieldName,
            )
            .map((o) => ({ entityId: o.entityId, value: o.value }));
        }),
      } as unknown as UnitLeaderCwidReadClient["fieldOverride"],
      orgUnitRoleAssignment: {
        findMany: vi.fn(async (args: unknown) => {
          calls++;
          const { where, orderBy } = args as {
            where: { entityType: string; entityId: { in: string[] }; roleKey: string };
            orderBy?: OrderBy;
          };
          return sortByOrderBy(
            opts.assignments.filter(
              (a) =>
                a.entityType === where.entityType &&
                where.entityId.in.includes(a.entityId) &&
                a.roleKey === where.roleKey,
            ),
            orderBy,
          ).map((a) => ({ entityId: a.entityId, cwid: a.cwid }));
        }),
      } as unknown as UnitLeaderCwidReadClient["orgUnitRoleAssignment"],
    };
  }

  const assignments: AssignmentRow[] = [
    // DIV_A: assignment only.
    { entityType: "division", entityId: "DIV_A", roleKey: "chief", cwid: "aaa0001", interim: false },
    // DIV_B: three holders — (sortOrder, cwid) picks bbb0005. Chosen so every
    // other ordering picks someone else: cwid-only → bbb0001, sortOrder-only
    // (insertion order within a tie) → bbb0009, no orderBy → bbb0001.
    { entityType: "division", entityId: "DIV_B", roleKey: "chief", cwid: "bbb0001", interim: false, sortOrder: 1 },
    { entityType: "division", entityId: "DIV_B", roleKey: "chief", cwid: "bbb0009", interim: false, sortOrder: 0 },
    { entityType: "division", entityId: "DIV_B", roleKey: "chief", cwid: "bbb0005", interim: false, sortOrder: 0 },
    // DIV_C: an assignment the override must beat.
    { entityType: "division", entityId: "DIV_C", roleKey: "chief", cwid: "ccc0001", interim: false },
    // DIV_D: an assignment an explicit-vacancy override must suppress.
    { entityType: "division", entityId: "DIV_D", roleKey: "chief", cwid: "ddd0001", interim: false },
    // DIV_F: a different role key — not the chief.
    { entityType: "division", entityId: "DIV_F", roleKey: "associate_chief", cwid: "fff0001", interim: false },
    // Same code under another entity type — must not leak in.
    { entityType: "department", entityId: "DIV_E", roleKey: "chief", cwid: "eee0001", interim: false },
  ];
  const overrides: OverrideRow[] = [
    { entityType: "division", entityId: "DIV_C", fieldName: "leaderCwid", value: "ovr0001" },
    { entityType: "division", entityId: "DIV_D", fieldName: "leaderCwid", value: "" },
    // An interim-only override does not change WHO.
    { entityType: "division", entityId: "DIV_A", fieldName: "leaderInterim", value: "true" },
    // An override on a unit with no assignment.
    { entityType: "division", entityId: "DIV_G", fieldName: "leaderCwid", value: "ggg0001" },
  ];
  const ids = ["DIV_A", "DIV_B", "DIV_C", "DIV_D", "DIV_E", "DIV_F", "DIV_G"];

  it("matches resolveUnitLeader's cwid for every unit, in two queries", async () => {
    const batch = makeBatchClient({ assignments, overrides });
    const got = await resolveUnitLeaderCwids({
      entityType: "division",
      entityIds: ids,
      roleKey: "chief",
      client: batch,
    });
    expect(batch.calls()).toBe(2);

    const single = makeClient({ assignments });
    const expected = new Map<string, string | null>();
    for (const id of ids) {
      const bag: UnitFieldOverrides = {};
      for (const o of overrides) {
        if (o.entityType === "division" && o.entityId === id) {
          (bag as Record<string, string>)[o.fieldName] = o.value;
        }
      }
      const r = await resolveUnitLeader({
        entityType: "division",
        entityId: id,
        roleKey: "chief",
        overrides: bag,
        fallbackLabel: "Chief",
        client: single,
      });
      expected.set(id, r?.cwid ?? null);
    }
    expect([...got]).toEqual([...expected]);
    expect(Object.fromEntries(got)).toEqual({
      DIV_A: "aaa0001",
      DIV_B: "bbb0005",
      DIV_C: "ovr0001",
      DIV_D: null,
      DIV_E: null,
      DIV_F: null,
      DIV_G: "ggg0001",
    });
  });

  it("no units → no queries", async () => {
    const batch = makeBatchClient({ assignments, overrides });
    const got = await resolveUnitLeaderCwids({
      entityType: "division",
      entityIds: [],
      roleKey: "chief",
      client: batch,
    });
    expect(got.size).toBe(0);
    expect(batch.calls()).toBe(0);
  });
});
