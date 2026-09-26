/**
 * #1166 Surface B on the shared RailLayout: picking an entity writes
 * `?entity=` with the `#publications` anchor and resets `?page=`; the feed's own
 * clear (URL → no entity) clears the rail selection. No "All" row, no subhead.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { CellLineEntity } from "@/lib/api/methods";

const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}));
vi.mock("@/components/method/publication-feed", () => ({
  FamilyPublicationFeed: () => <div data-testid="feed" />,
}));

import { FamilyEntityRailLayout } from "@/components/method/family-entity-rail-layout";

const entities = [
  { entityId: "e1", label: "HEK293", usageCount: 40, evidenced: true, parentEntityId: null, parentLabel: null, parentDescriptor: null, isGeneric: false, dominantKind: "organism_or_cells" },
  { entityId: "e2", label: "HeLa", usageCount: 12, evidenced: true, parentEntityId: null, parentLabel: null, parentDescriptor: null, isGeneric: false, dominantKind: "organism_or_cells" },
] as CellLineEntity[];

function renderIt() {
  return render(
    <FamilyEntityRailLayout
      entities={entities}
      supercategorySlug="animal-cell-models"
      familySegment="cancer-cell-lines-fam_0007"
      familyLabel="Cancer cell lines"
      cellLineLabels={{ e1: "HEK293", e2: "HeLa" }}
    />,
  );
}

describe("FamilyEntityRailLayout", () => {
  beforeEach(() => mockGet.mockReset());

  it("writes ?entity= with #publications and resets ?page=; no All row", () => {
    mockGet.mockReturnValue(null);
    window.history.replaceState(null, "", "/methods/sc/fam?page=3");
    const spy = vi.spyOn(window.history, "replaceState");
    renderIt();
    const rail = screen.getAllByRole("complementary", { name: "Cell lines" })[0];
    expect(within(rail).queryByText(/^All /)).toBeNull();
    fireEvent.click(within(rail).getByText("HeLa"));
    expect(spy).toHaveBeenLastCalledWith(null, "", "/methods/sc/fam?entity=e2#publications");
    expect(screen.queryByRole("button", { name: /^Clear HeLa/ })).toBeNull();
    spy.mockRestore();
  });

  it("follows the URL when the feed clears ?entity=", () => {
    mockGet.mockReturnValue("e1");
    const { rerender } = renderIt();
    const row = () =>
      within(screen.getAllByRole("complementary", { name: "Cell lines" })[0])
        .getByText("HEK293")
        .closest("button")!;
    expect(row().getAttribute("aria-current")).toBe("true");
    mockGet.mockReturnValue(null);
    rerender(
      <FamilyEntityRailLayout
        entities={entities}
        supercategorySlug="animal-cell-models"
        familySegment="cancer-cell-lines-fam_0007"
        familyLabel="Cancer cell lines"
        cellLineLabels={{ e1: "HEK293", e2: "HeLa" }}
      />,
    );
    expect(row().getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("taxonomy-rail-trigger").textContent).toContain("All cell lines");
  });

  it("mobile eyebrow is the singular kind noun, like Subarea / Family", () => {
    mockGet.mockReturnValue(null);
    renderIt();
    const trigger = screen.getByTestId("taxonomy-rail-trigger");
    expect(trigger.textContent).toMatch(/^Cell line/);
    expect(trigger.textContent).not.toMatch(/^Cell lines/);
  });
});
