import { describe, expect, it, vi } from "vitest";

import { canViewUsage, type UsageAccessClient } from "@/lib/edit/usage-access";

/** A `unitAdmin.findFirst` that honors the `where` it is given (cwid + entityType allowlist). */
function client(grants: Array<{ cwid: string; entityType: string }>): UsageAccessClient {
  return {
    unitAdmin: {
      findFirst: vi.fn(
        async ({ where }: { where: { cwid: string; entityType?: { in: string[] } } }) => {
          const hit = grants.find(
            (g) =>
              g.cwid === where.cwid &&
              (where.entityType?.in ?? [g.entityType]).includes(g.entityType),
          );
          return hit ? { cwid: hit.cwid } : null;
        },
      ),
    },
  } as unknown as UsageAccessClient;
}

describe("canViewUsage", () => {
  it("superuser: true without a DB read", async () => {
    const c = client([]);
    expect(await canViewUsage({ cwid: "su", isSuperuser: true }, c)).toBe(true);
    expect(c.unitAdmin.findFirst).not.toHaveBeenCalled();
  });

  it("any org-unit grant (department/division/center/core) qualifies", async () => {
    for (const entityType of ["department", "division", "center", "core"]) {
      expect(
        await canViewUsage({ cwid: "a", isSuperuser: false }, client([{ cwid: "a", entityType }])),
      ).toBe(true);
    }
  });

  it("an institution grant alone does NOT qualify; no grant does not qualify", async () => {
    expect(
      await canViewUsage(
        { cwid: "a", isSuperuser: false },
        client([{ cwid: "a", entityType: "institution" }]),
      ),
    ).toBe(false);
    expect(await canViewUsage({ cwid: "a", isSuperuser: false }, client([]))).toBe(false);
  });
});
