/**
 * GET /edit/orcid-coverage/export — unit labels are cosmetic (criteria block +
 * filename). A facet-load failure must not fail the download the page still
 * offers: the CSV prints the raw unit values instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  canView: vi.fn(),
  facets: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/edit/usage-access", () => ({ canViewUsage: h.canView }));
vi.mock("@/lib/api/data-quality", () => ({ loadDataQualityFacets: h.facets }));
vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/edit/orcid-coverage", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/edit/orcid-coverage")>()),
  loadOrcidCoverage: h.load,
}));

import { GET } from "@/app/edit/orcid-coverage/export/route";

const req = (qs: string) => new Request(`http://localhost/edit/orcid-coverage/export${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  h.session.mockResolvedValue({ cwid: "abc1234", isSuperuser: true });
  h.canView.mockResolvedValue(true);
  h.load.mockResolvedValue({ byDept: [] });
});

describe("GET /edit/orcid-coverage/export — unit labels", () => {
  it("uses facet labels when they load", async () => {
    h.facets.mockResolvedValue({
      departments: [{ value: "dept:N1234", label: "Medicine", divisions: [] }],
      centers: [],
      institutions: [],
    });
    const res = await GET(req("?unit=dept:N1234"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Medicine");
  });

  it("falls back to raw unit values when the facet load fails — still 200", async () => {
    h.facets.mockRejectedValue(new Error("db down"));
    const res = await GET(req("?unit=dept:N1234"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(await res.text()).toContain("dept:N1234");
  });

  it("skips the facet load when no unit is selected", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    expect(h.facets).not.toHaveBeenCalled();
  });
});
