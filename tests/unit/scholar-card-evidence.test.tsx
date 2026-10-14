/**
 * S5 (TOPIC_RANK_AREA_SIGNALS): the scholar card's evidence line and the
 * "Scholars in this area" info text. Fake scholars only.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScholarCardGrid, type ScholarCardData } from "@/components/taxonomy/scholar-card-grid";
import { areaSignalEvidenceText } from "@/components/taxonomy/scholar-card";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";

const POPOVER = { label: "Cardiology", topicSlug: "cardio", filterable: true };

function scholar(evidence?: ScholarCardData["evidence"]): ScholarCardData {
  return {
    cwid: "aaa1001",
    slug: "test-person-1",
    preferredName: "Test Person 1",
    primaryTitle: "Title 1",
    identityImageEndpoint: "",
    areas: ["Alpha"],
    ...(evidence ? { evidence } : {}),
  };
}

describe("areaSignalEvidenceText", () => {
  it("grants only, singular and plural", () => {
    expect(areaSignalEvidenceText({ grants: 1, trials: 0 })).toBe("PI on 1 grant in this area");
    expect(areaSignalEvidenceText({ grants: 2, trials: 0 })).toBe("PI on 2 grants in this area");
  });

  it("trials only, singular and plural", () => {
    expect(areaSignalEvidenceText({ grants: 0, trials: 1 })).toBe(
      "Leads 1 clinical trial in this area",
    );
    expect(areaSignalEvidenceText({ grants: 0, trials: 3 })).toBe(
      "Leads 3 clinical trials in this area",
    );
  });

  it("combined", () => {
    expect(areaSignalEvidenceText({ grants: 2, trials: 1 })).toBe(
      "PI on 2 grants · leads 1 trial in this area",
    );
    expect(areaSignalEvidenceText({ grants: 1, trials: 2 })).toBe(
      "PI on 1 grant · leads 2 trials in this area",
    );
  });

  it("absent or zero -> null", () => {
    expect(areaSignalEvidenceText(undefined)).toBeNull();
    expect(areaSignalEvidenceText({ grants: 0, trials: 0 })).toBeNull();
  });
});

describe("ScholarCard evidence line", () => {
  it("renders after the area bullets when evidence is present", () => {
    render(
      <ScholarCardGrid
        popover={POPOVER}
        heading="Scholars in this area"
        scholars={[scholar({ grants: 2, trials: 0 })]}
      />,
    );
    // Two copies of each card (narrow + md+).
    const lines = screen.getAllByTestId("scholar-card-evidence");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("PI on 2 grants in this area");
    // Placed after the areas list.
    const areas = screen.getAllByTestId("scholar-card-areas")[0];
    expect(areas.compareDocumentPosition(lines[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders nothing new when evidence is absent or zero", () => {
    const { container: without } = render(
      <ScholarCardGrid popover={POPOVER} heading="Scholars in this area" scholars={[scholar()]} />,
    );
    const baseline = without.innerHTML;
    expect(screen.queryByTestId("scholar-card-evidence")).toBeNull();
    const { container: zero } = render(
      <ScholarCardGrid
        popover={POPOVER}
        heading="Scholars in this area"
        scholars={[scholar({ grants: 0, trials: 0 })]}
      />,
    );
    expect(zero.innerHTML).toBe(baseline);
  });
});

describe("info text", () => {
  const open = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

  it("card grid: papers-only copy, nightly, when the flag is off", () => {
    render(<ScholarCardGrid popover={POPOVER} heading="Scholars in this area" scholars={[scholar()]} />);
    open("About Scholars in this area");
    expect(screen.getByText(/it updates nightly as new work appears/)).toBeTruthy();
    expect(screen.queryByText(/weekly/)).toBeNull();
    expect(screen.queryByText(/PI grants/)).toBeNull();
  });

  it("card grid: names grants and trials when areaSignals is on", () => {
    render(
      <ScholarCardGrid
        popover={POPOVER}
        heading="Scholars in this area"
        scholars={[scholar()]}
        areaSignals
      />,
    );
    open("About Scholars in this area");
    expect(
      screen.getByText(
        /For scholars who already publish in the area, PI grants and clinical trials they lead in the area also count toward their place\./,
      ),
    ).toBeTruthy();
  });

  it("chip row: same copy, gated the same way", () => {
    const chips = [
      { cwid: "aaa1001", slug: "t1", preferredName: "Test Person 1", primaryTitle: null, identityImageEndpoint: "", rank: 1 },
    ];
    const { unmount } = render(<TopScholarsChipRow scholars={chips} topicSlug="t" />);
    open("About Scholars in this area");
    expect(screen.getByText(/updates nightly/)).toBeTruthy();
    expect(screen.queryByText(/PI grants/)).toBeNull();
    unmount();
    render(<TopScholarsChipRow scholars={chips} topicSlug="t" areaSignals />);
    open("About Scholars in this area");
    expect(screen.getByText(/PI grants and clinical trials/)).toBeTruthy();
  });
});
