/**
 * `components/edit/data-quality-filters.tsx` — the client filter island. Verifies
 * auto-apply: every change navigates via router.replace to a query string the
 * server parser decodes (repeated ?type=/?unit=, the gap/overview-age selects, the
 * hidden-roles toggle, and the debounced search), with no "Apply" button. Also
 * checks the structural division indent (#3 fix).
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
}));

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

const lastUrl = () => String(replace.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => vi.clearAllMocks());

describe("DataQualityFilters — auto-apply", () => {
  it("has no Apply button", () => {
    renderFilters();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });

  it("navigates on facet toggle, carrying the full selection as repeated params", () => {
    renderFilters({ roleCategories: [] });
    fireEvent.click(screen.getByText("Full-time faculty"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toContain("type=full_time_faculty");
    // Toggling a second facet keeps the existing selection (still has the dept).
    fireEvent.click(screen.getByText("Postdoc"));
    const url = lastUrl();
    expect(url).toContain("type=full_time_faculty");
    expect(url).toContain("type=postdoc");
    expect(url).toContain("unit=dept%3AMED");
  });

  it("toggles a center into the shared unit set (encoded center:CODE)", () => {
    renderFilters({ units: [] });
    fireEvent.click(screen.getByText("Meyer Cancer Center"));
    expect(lastUrl()).toContain("unit=center%3AMCC");
  });

  it("navigates when the gap and overview-age selects change", () => {
    renderFilters();
    fireEvent.change(screen.getByLabelText("Gap"), { target: { value: "no-headshot" } });
    expect(lastUrl()).toContain("gap=no-headshot");
    fireEvent.change(screen.getByLabelText("Overview last updated"), {
      target: { value: "imported" },
    });
    expect(lastUrl()).toContain("overviewAge=imported");
  });

  it("navigates when the hide-students checkbox changes", () => {
    renderFilters();
    fireEvent.click(screen.getByLabelText(/Hide students/));
    expect(lastUrl()).toContain("hidden=0");
  });

  it("debounces the search box, then navigates with ?q=", () => {
    vi.useFakeTimers();
    try {
      renderFilters({ roleCategories: [], units: [] });
      fireEvent.change(screen.getByLabelText(/Search name or CWID/), {
        target: { value: "harrington" },
      });
      expect(replace).not.toHaveBeenCalled(); // debounced
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(lastUrl()).toContain("q=harrington");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the search immediately on Enter", () => {
    const { container } = renderFilters({ roleCategories: [], units: [] });
    fireEvent.change(screen.getByLabelText(/Search name or CWID/), { target: { value: "silver" } });
    fireEvent.submit(container.querySelector("form")!);
    expect(lastUrl()).toContain("q=silver");
  });

  it("Clear navigates back to the unfiltered route", () => {
    renderFilters();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(replace).toHaveBeenLastCalledWith("/edit/data-quality", { scroll: false });
  });

  it("renders departments and divisions as a flat (non-indented) list", () => {
    renderFilters();
    // No facet option carries an indent — divisions are disambiguated by their
    // parent in the label instead, so nothing implies false nesting under search.
    for (const btn of document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")) {
      expect(btn.style.paddingInlineStart).toBe("");
    }
  });
});
