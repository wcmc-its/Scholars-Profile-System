/**
 * Report 1's server body: loads the rows once, puts "Last refreshed …" in the
 * header subtitle (none before the first weekly run), and hands the card the
 * URL's parsed thresholds, the unit param to keep and the export cap.
 */
import { render, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ load: vi.fn(), card: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: { read: {} } }));
vi.mock("@/lib/center-collaboration/collab-report-rows", () => ({ loadCollabReportRows: h.load }));
vi.mock("@/components/edit/cancer-center-collab-report-card", () => ({
  CancerCenterCollabReportCard: (props: unknown) => {
    h.card(props);
    return <div data-testid="card" />;
  },
}));

import { renderOptimizeMembershipReport } from "@/components/edit/reports/optimize-membership-body";
import type { UnitReportProps } from "@/lib/edit/report-registry";

function props(searchParams: UnitReportProps["searchParams"]): UnitReportProps {
  return {
    n: "1",
    code: "meyer_cancer_center",
    kind: "center",
    ctx: {} as UnitReportProps["ctx"],
    session: {} as UnitReportProps["session"],
    searchParams,
    basePath: "/edit/reports/optimize-membership",
  };
}

beforeEach(() => vi.clearAllMocks());

describe("renderOptimizeMembershipReport", () => {
  it("stamps the subtitle and passes the parsed URL to the card", async () => {
    h.load.mockResolvedValue({ rows: [], lastRefreshedAt: "2026-09-20T12:05:00.000Z" });
    const out = await renderOptimizeMembershipReport(
      props({ center: "meyer_cancer_center", c: "4", xmode: "percent", tab: "recruit" }),
    );
    const { container } = render(
      <>
        {out.subtitle}
        {out.main}
      </>,
    );
    expect(within(container).getByTestId("om-refreshed").textContent).toBe(
      "Last refreshed Sep 20, 2026, 8:05 AM",
    );
    expect(h.load).toHaveBeenCalledWith({}, "meyer_cancer_center");
    expect(h.card).toHaveBeenCalledWith(
      expect.objectContaining({
        centerCode: "meyer_cancer_center",
        initial: expect.objectContaining({ c: 4, xmode: "percent", x: 20, tab: "recruit" }),
        keepQuery: "center=meyer_cancer_center",
        basePath: "/edit/reports/optimize-membership",
        cap: 50,
      }),
    );
  });

  it("has no refreshed stamp before the first weekly run", async () => {
    h.load.mockResolvedValue({ rows: [], lastRefreshedAt: null });
    const out = await renderOptimizeMembershipReport(props({}));
    expect(out.subtitle).toBeUndefined();
  });
});
