import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const hoisted = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/lib/edit/cancer-center-publications-report", () => ({
  HIGH_IMPACT_THRESHOLD: 10,
  loadUnitPublicationsReport: hoisted.load,
}));
vi.mock("@/components/edit/publications-report-table", () => ({
  PublicationsReportTable: ({ stageEnabled }: { stageEnabled?: boolean }) => (
    <div data-testid="table" data-stage={String(Boolean(stageEnabled))} />
  ),
}));

import { renderPublicationsReport } from "@/components/edit/reports/publications-body";

const stages = ["T2", "T0", null, null] as const;
const REPORT = {
  totalPublications: 6,
  matchedPublications: 4,
  matchRatePct: 66.7,
  highImpactCount: 1,
  highImpactRatePct: 25,
  rows: stages.map((s, i) => ({ pmid: String(i), translationalStage: s })),
};
const ctx = { unit: { name: "Synthetic Center" } } as never;

afterEach(() => {
  delete process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET;
  hoisted.load.mockReset();
});

describe("Publications report body, translational stage", () => {
  it("flag on: asks the loader for stage, states the mix with the unclassified remainder", async () => {
    process.env.SEARCH_PUBS_TRANSLATIONAL_STAGE_FACET = "on";
    hoisted.load.mockResolvedValue(REPORT);
    const out = await renderPublicationsReport({ code: "C1", kind: "center", ctx } as never);
    render(<>{out.main}</>);
    expect(hoisted.load).toHaveBeenCalledWith("center", "C1", { stage: true });
    expect(screen.getByTestId("pubs-report-stage-line").textContent).toBe(
      "Translational stage, matched publications: T0 1 · T1 0 · T2 1 · T3–4 0 · No stage 2 (50% classified).",
    );
    expect(screen.getByTestId("table").getAttribute("data-stage")).toBe("true");
  });

  it("flag off: no stage line, loader not asked, table without stage", async () => {
    hoisted.load.mockResolvedValue(REPORT);
    const out = await renderPublicationsReport({ code: "C1", kind: "center", ctx } as never);
    render(<>{out.main}</>);
    expect(hoisted.load).toHaveBeenCalledWith("center", "C1", { stage: false });
    expect(screen.queryByTestId("pubs-report-stage-line")).toBeNull();
    expect(screen.getByTestId("table").getAttribute("data-stage")).toBe("false");
  });
});
