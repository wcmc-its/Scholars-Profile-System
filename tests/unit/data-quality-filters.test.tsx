/**
 * `components/edit/data-quality-filters.tsx` — the client filter island. Verifies
 * the Set→hidden-input bridge (the repeated ?type=/?unit= the server parser
 * decodes), the hide-students checkbox polarity, and the structural division
 * indent (#3 fix).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DataQualityFilters } from "@/components/edit/data-quality-filters";

const facets = {
  roleCategories: [
    { value: "full_time_faculty", label: "Full-time faculty", count: 10 },
    { value: "postdoc", label: "Postdoc", count: 5 },
  ],
  departments: [
    {
      value: "dept:MED",
      label: "Medicine",
      count: 8,
      divisions: [{ value: "div:CARD", label: "Cardiology", count: 4 }],
    },
  ],
  centers: [{ value: "center:MCC", label: "Meyer Cancer Center", count: 7 }],
};

function renderFilters(over: Record<string, unknown> = {}) {
  return render(
    <DataQualityFilters
      facets={facets as never}
      roleCategories={["postdoc"]}
      units={["dept:MED"]}
      q=""
      gap="all"
      overviewAge="all"
      includeHidden={true}
      {...over}
    />,
  );
}

const names = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll(`input[name="${name}"]`)].map((i) => (i as HTMLInputElement).value);

describe("DataQualityFilters", () => {
  it("posts a GET form to the dashboard route", () => {
    const { container } = renderFilters();
    const form = container.querySelector("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe("/edit/data-quality");
  });

  it("mirrors the seeded selections into hidden type/unit inputs", () => {
    const { container } = renderFilters();
    expect(names(container, "type")).toEqual(["postdoc"]);
    expect(names(container, "unit")).toEqual(["dept:MED"]);
  });

  it("adds a hidden input when a facet option is toggled on, removes it when toggled off", () => {
    const { container } = renderFilters({ roleCategories: [] });
    fireEvent.click(screen.getByText("Full-time faculty"));
    expect(names(container, "type")).toContain("full_time_faculty");
    fireEvent.click(screen.getByText("Full-time faculty"));
    expect(names(container, "type")).not.toContain("full_time_faculty");
  });

  it("toggles a center into the shared unit set (encoded center:CODE)", () => {
    const { container } = renderFilters({ units: [] });
    fireEvent.click(screen.getByText("Meyer Cancer Center"));
    expect(names(container, "unit")).toEqual(["center:MCC"]);
  });

  it("checks the hide-students box exactly when includeHidden is false", () => {
    const hidden = renderFilters({ includeHidden: false });
    expect((hidden.getByLabelText(/Hide students/) as HTMLInputElement).checked).toBe(true);
    hidden.unmount();
    const shown = renderFilters({ includeHidden: true });
    expect((shown.getByLabelText(/Hide students/) as HTMLInputElement).checked).toBe(false);
  });

  it("indents division options structurally under their parent department", () => {
    renderFilters();
    const cardio = screen.getByText("Cardiology").closest("button")!;
    expect(cardio.style.paddingInlineStart).toBe("1rem");
    // The department row above it is not indented.
    const med = screen.getByText("Medicine").closest("button")!;
    expect(med.style.paddingInlineStart).toBe("");
  });
});
