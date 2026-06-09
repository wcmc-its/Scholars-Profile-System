import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MethodsSection } from "@/components/profile/methods-section";
import type { ScholarFamilyView } from "@/lib/api/profile";

function makeFamilies(n: number): ScholarFamilyView[] {
  return Array.from({ length: n }, (_, i) => ({
    familyId: `fam_${i + 1}`,
    familyLabel: `Family ${i + 1}`,
    supercategory: "imaging_microscopy",
    pubCount: 100 - i,
    exemplarTools: [`Tool ${i + 1}A`, `Tool ${i + 1}B`],
  }));
}

describe("MethodsSection", () => {
  it("renders family labels, dot-joined exemplar tools, and counts", () => {
    render(<MethodsSection families={makeFamilies(2)} />);
    expect(screen.getByText("Family 1")).toBeTruthy();
    expect(screen.getByText("Tool 1A · Tool 1B")).toBeTruthy(); // exemplars joined with " · "
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("99")).toBeTruthy();
  });

  it("omits the exemplar sub-line when a family has no exemplar tools", () => {
    render(
      <MethodsSection
        families={[
          {
            familyId: "fam_1",
            familyLabel: "Solo family",
            supercategory: "s",
            pubCount: 5,
            exemplarTools: [],
          },
        ]}
      />,
    );
    expect(screen.getByText("Solo family")).toBeTruthy();
    // The mono exemplar line uses " · " joins; none should be present.
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it("renders nothing when there are no families", () => {
    const { container } = render(<MethodsSection families={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("caps at 8 families and shows a '+ N more' line for the remainder", () => {
    render(<MethodsSection families={makeFamilies(11)} />);
    expect(screen.getByText("Family 8")).toBeTruthy();
    expect(screen.queryByText("Family 9")).toBeNull();
    expect(screen.getByText("+ 3 more method families")).toBeTruthy();
  });

  it("uses the singular 'family' when exactly one is hidden", () => {
    render(<MethodsSection families={makeFamilies(9)} />);
    expect(screen.getByText("+ 1 more method family")).toBeTruthy();
  });
});
