import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrialResultRow, trialDatesLabel, trialMatchLine, trialProgress } from "@/components/search/trial-result-row";
import type { TrialHit } from "@/lib/api/search-trials";

const hit = (over: Partial<TrialHit> = {}): TrialHit => ({
  trialId: "NCT02807272",
  nctNumber: "NCT02807272",
  title: "Tipifarnib in CMML and AML",
  status: "OPEN TO ACCRUAL",
  statusBucket: "active",
  phase: "2",
  studyType: "INTERVENTIONAL",
  sponsorClass: "industry",
  principalSponsor: "Kura Oncology",
  pis: [1, 2, 3, 4].map((i) => ({ cwid: `c${i}`, name: `PI ${i}`, slug: `pi-${i}` })),
  conditions: "Acute Myeloid Leukemia; Myelodysplastic Syndrome; CMML; Anemia",
  statusKey: "recruiting",
  startDate: "2016-09",
  startEstimated: false,
  endDate: "2020-06",
  endEstimated: false,
  interventions: "Drug: Gilteritinib; Drug: Midostaurin",
  hasResults: true,
  matchedConcept: true,
  matchedFields: ["title", "conditions"],
  ...over,
});

describe("trialMatchLine", () => {
  it("names the concept, and the title when the text hit it too", () => {
    expect(trialMatchLine(hit(), "leukemia", "Leukemia")).toEqual({ kind: "Concept", text: "Leukemia in conditions and title" });
    expect(trialMatchLine(hit({ matchedFields: ["meshTerms"] }), "leukemia", "Leukemia")?.text).toBe("Leukemia in conditions");
  });
  it("falls back to the first text field that matched", () => {
    expect(trialMatchLine(hit({ matchedConcept: false }), "leukemia", "Leukemia")).toEqual({
      kind: "Title",
      text: "contains “leukemia”",
    });
    expect(trialMatchLine(hit({ matchedConcept: false, matchedFields: [] }), "leukemia", null)).toBeNull();
  });
});

describe("TrialResultRow", () => {
  it("renders the status pill, type · phase, NCT link, PI pills with +N more, sponsor and capped conditions", () => {
    const { container } = render(<TrialResultRow hit={hit()} q="leukemia" conceptLabel="Leukemia" />);
    expect(screen.getByText("Recruiting")).toBeTruthy();
    expect(screen.getByText("Drug: Gilteritinib · Drug: Midostaurin")).toBeTruthy();
    expect(screen.getByText("Sep 2016 – Jun 2020", { exact: false })).toBeTruthy();
    expect(screen.getByText("· Results posted")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("100% of the planned study period elapsed");
    expect(screen.getByText("Interventional · Phase 2")).toBeTruthy();
    expect(screen.getByText("NCT02807272 ↗").getAttribute("href")).toBe("https://clinicaltrials.gov/study/NCT02807272");
    expect(container.querySelectorAll("a[href^='/scholars/'], a[href*='pi-']")).toHaveLength(4);
    // One for the 4th PI, one for the 4th condition.
    expect(screen.getAllByText("+1 more")).toHaveLength(2);
    expect(screen.getByText("Kura Oncology")).toBeTruthy();
    expect(screen.getByText("Acute Myeloid Leukemia").className).toContain("amber");
    expect(screen.queryByText("Anemia")).toBeNull();
    expect(screen.getByText("Leukemia in conditions and title", { exact: false })).toBeTruthy();
  });
  it("labels a protocol without an NCT as a WCM protocol", () => {
    render(
      <TrialResultRow
        hit={hit({ nctNumber: null, trialId: "19-06020313", statusKey: "terminated", interventions: null, hasResults: false })}
        q=""
        conceptLabel={null}
      />,
    );
    expect(screen.getByText("WCM protocol 19-06020313")).toBeTruthy();
    expect(screen.getByText("Terminated")).toBeTruthy();
    expect(screen.queryByText("Intervention")).toBeNull();
    expect(screen.queryByText("· Results posted")).toBeNull();
  });
});

describe("trial dates", () => {
  it("labels the span, marks estimates, and handles a missing end", () => {
    const d = { startDate: "2025-11", startEstimated: false, endDate: "2029-03", endEstimated: true };
    expect(trialDatesLabel(d)).toBe("Nov 2025 – Mar 2029 (est.)");
    expect(trialDatesLabel({ ...d, endDate: null })).toBe("Started Nov 2025");
    expect(trialDatesLabel({ ...d, startDate: null })).toBeNull();
  });
  it("progress is the elapsed share, clamped to 4–100", () => {
    const now = new Date(2026, 8, 1); // Sep 2026
    expect(trialProgress({ startDate: "2024-09", endDate: "2028-09" }, now)).toBe(50);
    expect(trialProgress({ startDate: "2027-01", endDate: "2029-01" }, now)).toBe(4);
    expect(trialProgress({ startDate: "2016-09", endDate: "2020-06" }, now)).toBe(100);
    expect(trialProgress({ startDate: "2016-09", endDate: null }, now)).toBeNull();
  });
});
