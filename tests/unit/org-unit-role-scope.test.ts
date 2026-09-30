/**
 * `isRoleAllowedAtUnit` — the #2557 Phase E amendment read helper
 * (`lib/api/org-unit-role-scope.ts`).
 *
 * Pure DB-free logic: `client` is a hand-rolled stub, never a real
 * `PrismaClient`, exactly like `buildRoleRoster`'s tests
 * (`tests/unit/org-unit-roles-admin.test.ts`).
 *
 * This file pins the helper's contract standalone, independent of its caller:
 * zero rows for a (entityType, roleKey) pair is unrestricted, one or more
 * rows is an allowlist, and a different role's rows never leak into another
 * role's decision. The wired-in behavior at the call sites (`handleCenter`
 * and `handleCornellAdd` in `app/api/edit/roster/route.ts`) is covered
 * separately in `tests/unit/roster-route-role-scope.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { isRoleAllowedAtUnit } from "@/lib/api/org-unit-role-scope";

type ScopeRow = { entityType: string; roleKey: string; entityId: string };

function makeClient(rows: ScopeRow[]) {
  return {
    orgUnitRoleScope: {
      findMany: async (args: { where: { entityType: string; roleKey: string } }) =>
        rows
          .filter(
            (r) =>
              r.entityType === args.where.entityType && r.roleKey === args.where.roleKey,
          )
          .map((r) => ({ entityId: r.entityId })),
    },
    // Cast at the call site keeps the stub terse without re-declaring all of
    // PrismaClient — the helper only ever touches this one read.
  } as unknown as Parameters<typeof isRoleAllowedAtUnit>[0]["client"];
}

describe("isRoleAllowedAtUnit", () => {
  it("a role with zero scope rows is unrestricted — allowed anywhere", async () => {
    const client = makeClient([]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "member",
        entityId: "some_other_center",
        client,
      }),
    ).resolves.toBe(true);
  });

  it("a restricted role allows ONLY the listed unit", async () => {
    const client = makeClient([
      { entityType: "center", roleKey: "research", entityId: "meyer_cancer_center" },
    ]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "research",
        entityId: "meyer_cancer_center",
        client,
      }),
    ).resolves.toBe(true);
  });

  it("a restricted role denies an unlisted unit", async () => {
    const client = makeClient([
      { entityType: "center", roleKey: "research", entityId: "meyer_cancer_center" },
    ]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "research",
        entityId: "some_other_center",
        client,
      }),
    ).resolves.toBe(false);
  });

  it("a different roleKey's rows do not leak into this one's decision", async () => {
    // `clinical` is scoped to Meyer only; `member` has no rows of its own and
    // must stay unrestricted despite `clinical`'s row existing in the table.
    const client = makeClient([
      { entityType: "center", roleKey: "clinical", entityId: "meyer_cancer_center" },
    ]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "member",
        entityId: "some_other_center",
        client,
      }),
    ).resolves.toBe(true);
  });

  it("a different roleKey's allowlist does not grant access to an unscoped-for-it unit", async () => {
    // `research` is scoped to Meyer only. A `clinical` row existing for a
    // DIFFERENT center must not make `research` allowed there.
    const client = makeClient([
      { entityType: "center", roleKey: "research", entityId: "meyer_cancer_center" },
      { entityType: "center", roleKey: "clinical", entityId: "some_other_center" },
    ]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "research",
        entityId: "some_other_center",
        client,
      }),
    ).resolves.toBe(false);
  });

  it("a different entityType with the same roleKey does not leak either", async () => {
    const client = makeClient([
      { entityType: "core", roleKey: "director", entityId: "some_core" },
    ]);
    await expect(
      isRoleAllowedAtUnit({
        entityType: "center",
        roleKey: "director",
        entityId: "meyer_cancer_center",
        client,
      }),
    ).resolves.toBe(true);
  });
});
