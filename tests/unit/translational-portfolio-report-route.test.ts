/**
 * Report 26's `.xlsx` route (`GET /api/edit/reports/translational-portfolio`)
 * never scopes to one scholar. Its gate (`canViewTranslationalPortfolioReport`)
 * is wider than the scholar page's (`authorizeCvExport`), so a `?cwid=` here
 * would hand any report viewer one scholar's counts; the route ignores it, as
 * the report page does. The db is mocked; the fixture CWID is invented.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  canView: vi.fn(),
  load: vi.fn(),
  build: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} }, prisma: {} }));
vi.mock("@/lib/auth/effective-identity", () => ({ getEffectiveEditSession: h.session }));
vi.mock("@/lib/auth/partner-login", () => ({ getPartnerEditSession: async () => null }));
vi.mock("@/lib/edit/translational-portfolio-report", async (actual) => ({
  ...(await actual<typeof import("@/lib/edit/translational-portfolio-report")>()),
  isTranslationalPortfolioReportEnabled: () => true,
  canViewTranslationalPortfolioReport: h.canView,
  loadPortfolioChoices: async () => ({ facets: {}, labels: new Map(), areas: [] }),
  loadPortfolio: h.load,
  buildPortfolioWorkbook: h.build,
}));

import { GET } from "@/app/api/edit/reports/translational-portfolio/route";

beforeEach(() => {
  vi.clearAllMocks();
  h.session.mockResolvedValue({ cwid: "view001", isSuperuser: false, isCommsSteward: false });
  h.canView.mockResolvedValue(true);
  h.load.mockResolvedValue({});
  h.build.mockResolvedValue(Buffer.from("xlsx"));
});

describe("the report download", () => {
  it("ignores ?cwid=: a report viewer gets the report's scope, never one scholar's", async () => {
    const res = await GET(
      new Request(
        "http://x/api/edit/reports/translational-portfolio?cwid=abc1234&from=2021&to=2024&unit=dept:N1",
      ),
    );
    expect(res.status).toBe(200);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load.mock.calls[0][0]).toMatchObject({ cwid: null, from: 2021, to: 2024, units: ["dept:N1"] });
    expect(h.build.mock.calls[0][0]).toMatchObject({ cwid: null });
  });

  it("is still closed to a viewer without report 26", async () => {
    h.canView.mockResolvedValue(false);
    const res = await GET(new Request("http://x/api/edit/reports/translational-portfolio?cwid=abc1234"));
    expect(res.status).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });
});
