/** Person-type facet: Cornell Ithaca types only on the pages that opt in (ORCID queue / coverage). */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { loadDataQualityFacets } from "@/lib/api/data-quality";

function fakeClient() {
  const groupBy = vi.fn(async (args: { by: string[]; where: unknown }) =>
    args.by[0] === "roleCategory"
      ? [
          { roleCategory: "full_time_faculty", _count: { _all: 3 } },
          { roleCategory: "ithaca_faculty", _count: { _all: 2 } },
        ]
      : [],
  );
  const empty = { findMany: vi.fn(async () => []) };
  const client = {
    department: empty,
    division: empty,
    center: empty,
    scholar: { groupBy, count: vi.fn(async () => 0) },
    centerMembership: { groupBy: vi.fn(async () => []) },
  };
  return { client: client as never, groupBy };
}

const roleWhere = (groupBy: ReturnType<typeof fakeClient>["groupBy"]) =>
  groupBy.mock.calls.find(([a]) => a.by[0] === "roleCategory")![0].where;

describe("loadDataQualityFacets person types", () => {
  it("counts active scholars only by default (Profiles, reports, COI)", async () => {
    const { client, groupBy } = fakeClient();
    await loadDataQualityFacets(client);
    expect(roleWhere(groupBy)).toEqual({ deletedAt: null, status: "active" });
  });

  it("with ithacaRoles, also counts Cornell Ithaca rows and labels their types", async () => {
    const { client, groupBy } = fakeClient();
    const f = await loadDataQualityFacets(client, { ithacaRoles: true });
    expect(roleWhere(groupBy)).toEqual({
      deletedAt: null,
      OR: [{ status: "active" }, { campus: "ithaca", status: "external" }],
    });
    expect(f.roleCategories.map((o) => o.label)).toEqual([
      "Full-time faculty",
      "Cornell Ithaca faculty",
    ]);
  });
});
