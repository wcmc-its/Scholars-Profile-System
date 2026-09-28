import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrialResultRow, trialMatchLine } from "@/components/search/trial-result-row";
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
    expect(screen.getByText("Active")).toBeTruthy();
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
    render(<TrialResultRow hit={hit({ nctNumber: null, trialId: "19-06020313", statusBucket: "completed" })} q="" conceptLabel={null} />);
    expect(screen.getByText("WCM protocol 19-06020313")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
  });
});
