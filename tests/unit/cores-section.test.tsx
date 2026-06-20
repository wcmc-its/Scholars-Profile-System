/**
 * The read-only "Cores used" chip row (components/profile/cores-section).
 * Renders nothing when empty; otherwise a chip per core with its pub count, and
 * — unlike Topics/Methods — no clickable filter buttons for the chips.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CoresSection } from "@/components/profile/cores-section";
import type { ScholarCoreUsage } from "@/lib/api/scholar-cores";

const CORES: ScholarCoreUsage[] = [
  { coreId: "2", name: "Biomedical Imaging", pubCount: 4 },
  { coreId: "5", name: "Flow Cytometry", pubCount: 1 },
];

describe("CoresSection", () => {
  it("renders a read-only chip per core with its publication count", () => {
    render(<CoresSection cores={CORES} />);
    expect(screen.getByText("Cores used")).toBeTruthy();
    expect(screen.getByText("Biomedical Imaging")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("Flow Cytometry")).toBeTruthy();
    // Display-only: the chips are not buttons (only the info tooltip trigger is).
    expect(screen.queryByRole("button", { name: /Biomedical Imaging/i })).toBeNull();
  });

  it("renders nothing when there is no confirmed core usage", () => {
    const { container } = render(<CoresSection cores={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
