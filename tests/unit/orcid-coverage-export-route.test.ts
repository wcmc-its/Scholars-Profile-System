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

  it("campus=all leads the table with a Campus column; no campus and ithaca keep theirs", async () => {
    const row = { people: 1, orcid: 0, confirmed: 0, strong: 0, weak: 0, era: 0, both: 0 };
    const nih = { nihPeople: 0, nihOrcid: 0, nihStrong: 0, nihPi: 0, nihPiEra: 0 };
    h.load.mockResolvedValue({
      byDept: [{ key: "Physics", label: "Physics", campus: "ithaca", ...row, ...nih }],
    });
    const table = async (qs: string) => (await (await GET(req(qs))).text()).split("\r\n\r\n")[1];
    const header = (await table("")).split("\r\n")[0];
    expect(header.startsWith("Department,People,")).toBe(true);
    expect((await table("?campus=ithaca")).split("\r\n")[0]).toBe(header);
    expect((await table("?campus=mars")).split("\r\n")[0]).toBe(header);
    const both = (await table("?campus=all")).split("\r\n");
    expect(both[0]).toBe(`Campus,${header}`);
    expect(both[1]).toBe("Cornell Ithaca,Physics,1,0,0,0.0,0,0,,,,,,,,,");
    const res = await GET(req("?campus=all"));
    expect(res.headers.get("Content-Disposition")).toMatch(/both-campuses/);
  });

  it("skips the facet load when no unit is selected", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    expect(h.facets).not.toHaveBeenCalled();
  });
});
