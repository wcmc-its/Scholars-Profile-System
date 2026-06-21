/**
 * #917 follow-up A — `BiosketchProgress` (`components/edit/biosketch-progress.tsx`). The
 * phase-weighted milestone math (`biosketchPhasePercent`) and the rendered bar / label / elapsed.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`): textContent + getAttribute.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  BiosketchProgress,
  biosketchPhasePercent,
} from "@/components/edit/biosketch-progress";

describe("biosketchPhasePercent — phase-weighted milestones", () => {
  it("advances monotonically across the phases", () => {
    expect(biosketchPhasePercent({ phase: "drafting", done: 0, total: 0 })).toBe(15);
    expect(biosketchPhasePercent({ phase: "faithfulness", done: 0, total: 2 })).toBe(40);
    expect(biosketchPhasePercent({ phase: "faithfulness", done: 1, total: 2 })).toBe(58);
    expect(biosketchPhasePercent({ phase: "faithfulness", done: 2, total: 2 })).toBe(75);
    expect(biosketchPhasePercent({ phase: "products", done: 0, total: 0 })).toBe(80);
    expect(biosketchPhasePercent({ phase: "sources", done: 0, total: 0 })).toBe(90);
    expect(biosketchPhasePercent({ phase: "done", done: 0, total: 0 })).toBe(100);
  });

  it("never exceeds 75 on the faithfulness phase even if done overshoots total", () => {
    expect(biosketchPhasePercent({ phase: "faithfulness", done: 9, total: 2 })).toBe(75);
  });

  it("falls back to a low value for an unknown phase (total=0 guard)", () => {
    expect(biosketchPhasePercent({ phase: "starting", done: 0, total: 0 })).toBe(5);
    expect(biosketchPhasePercent({ phase: "faithfulness", done: 0, total: 0 })).toBe(40);
  });
});

describe("BiosketchProgress — render", () => {
  it("renders the phase label and a m:ss elapsed counter with a soft hint", () => {
    render(
      <BiosketchProgress
        state={{ phase: "faithfulness", done: 1, total: 2 }}
        mode="contributions"
        elapsedMs={83_000}
      />,
    );
    expect(screen.getByTestId("biosketch-progress-label").textContent).toContain(
      "Fact-checking",
    );
    expect(screen.getByTestId("biosketch-progress-elapsed").textContent).toContain("1:23");
    expect(screen.getByTestId("biosketch-progress-elapsed").textContent).toContain("60–90 seconds");
  });

  it("uses the statement-specific drafting label + hint in Personal Statement mode", () => {
    render(
      <BiosketchProgress
        state={{ phase: "drafting", done: 0, total: 0 }}
        mode="personal_statement"
        elapsedMs={0}
      />,
    );
    expect(screen.getByTestId("biosketch-progress-label").textContent).toContain(
      "Drafting your statement",
    );
    expect(screen.getByTestId("biosketch-progress-elapsed").textContent).toContain("30–60 seconds");
  });
});
