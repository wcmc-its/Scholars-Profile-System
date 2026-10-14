/**
 * TOPIC_RANK_AREA_SIGNALS: the "Scholars in this area" info text names PI
 * grants and led clinical trials only when the page passes `areaSignals`, and
 * says "nightly" either way. Fake scholars only.
 */
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScholarCardGrid, type ScholarCardData } from "@/components/taxonomy/scholar-card-grid";
import { TopScholarsChipRow } from "@/components/topic/top-scholars-chip-row";

const POPOVER = { label: "Cardiology", topicSlug: "cardio", filterable: true };

function scholar(): ScholarCardData {
  return {
    cwid: "aaa1001",
    slug: "test-person-1",
    preferredName: "Test Person 1",
    primaryTitle: "Title 1",
    identityImageEndpoint: "",
    areas: ["Alpha"],
  };
}

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
