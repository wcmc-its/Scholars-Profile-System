/**
 * `components/edit/profiles-filters.tsx` — the Profiles roster's client filter
 * island (formerly `data-quality-filters.tsx` / `DataQualityFilters`, folded in
 * when the standalone Data Quality dashboard merged into `/edit/profiles`, then
 * split again so COI moved to its own page/component — `coi-filters.tsx`).
 * Verifies auto-apply: every change navigates via router.replace to a query
 * string the server parser decodes (repeated ?type=/?unit=, the gap and
 * overview-age selects, the hidden-roles toggle, and the debounced search),
 * with no "Apply" button. Also checks the structural division indent (#3 fix).
 *
 * This component has NO COI awareness at all (no `canSeeCoi` prop, no COI gap
 * option, not even hidden) — that lives entirely in `CoiFilters` now.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams("type=postdoc&page=2"),
}));

import { ProfilesFilters, ProfilesSearch } from "@/components/edit/profiles-filters";

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
  institutions: [{ value: "inst:HSS", label: "Hospital for Special Surgery", count: 3 }],
};

function renderFilters(over: Record<string, unknown> = {}) {
  return render(
    <ProfilesFilters
      facets={facets as never}
      roleCategories={["postdoc"]}
      units={["dept:MED"]}
      q=""
      gap="all"
      overviewAge="all"
      includeStudents={false}
      hiddenOnly={false}
      ranks={[]}
      {...over}
    />,
  );
}

const lastUrl = () => String(replace.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => vi.clearAllMocks());

describe("ProfilesFilters — auto-apply", () => {
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

  it("hides zero-member centers unless selected", () => {
    const withEmpty = {
      ...facets,
      centers: [...facets.centers, { value: "center:EMPTY", label: "Empty Center", count: 0 }],
    };
    const { unmount } = renderFilters({ facets: withEmpty, units: [] });
    expect(screen.queryByText("Empty Center")).toBeNull();
    unmount();
    renderFilters({ facets: withEmpty, units: ["center:EMPTY"] });
    expect(screen.getByText("Empty Center")).toBeTruthy();
  });

  it("renders an Institution facet below Centers and toggles inst:CODE into the shared unit set", () => {
    renderFilters({ units: [] });
    const titles = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(titles.indexOf("Institution")).toBe(titles.indexOf("Centers") + 1);
    fireEvent.click(screen.getByText("Hospital for Special Surgery"));
    expect(lastUrl()).toContain("unit=inst%3AHSS");
  });

  it("the Gap select offers exactly Any/Missing headshot/Missing overview — no COI option, ever", () => {
    renderFilters();
    const select = screen.getByLabelText("Gap") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["all", "no-headshot", "no-overview"]);
    expect(values).not.toContain("has-coi");
    fireEvent.change(select, { target: { value: "no-headshot" } });
    expect(lastUrl()).toContain("gap=no-headshot");
  });

  it("the Overview last updated select offers Any/Imported/No overview/<1yr/1-2yr/>2yr, and navigates with ?overviewAge=", () => {
    renderFilters();
    const select = screen.getByLabelText("Overview last updated") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["all", "imported", "never", "lt1yr", "1to2yr", "gt2yr"]);
    fireEvent.change(select, { target: { value: "imported" } });
    expect(lastUrl()).toContain("overviewAge=imported");
  });

  it("hides students by default; switching the toggle off includes them (?students=1)", () => {
    renderFilters();
    const toggle = screen.getByTestId("profiles-hide-students");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(lastUrl()).toContain("students=1");
  });

  it("offers a Rank facet and navigates with ?rank=", () => {
    renderFilters({
      facets: {
        ...facets,
        ranks: [{ value: "instructor", label: "Instructor", count: 900 }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Instructor/ }));
    expect(lastUrl()).toContain("rank=instructor");
  });

  it("explains the students toggle", () => {
    renderFilters();
    expect(screen.getByRole("button", { name: /don’t have their own profiles/ })).toBeTruthy();
  });

  it("filters to hidden profiles only (?visibility=hidden)", () => {
    renderFilters();
    fireEvent.click(screen.getByTestId("profiles-hidden-only"));
    expect(lastUrl()).toContain("visibility=hidden");
  });

  it("has no search box and no 'Filters apply automatically' filler", () => {
    renderFilters();
    expect(screen.queryByLabelText(/Search name or CWID/)).toBeNull();
    expect(screen.queryByText(/Filters apply automatically/)).toBeNull();
  });

  it("keeps the search term when a rail filter changes", () => {
    renderFilters({ q: "smith" });
    fireEvent.click(screen.getByTestId("profiles-hidden-only"));
    expect(lastUrl()).toContain("q=smith");
  });
});

describe("ProfilesSearch — above the table", () => {
  it("debounces, then navigates with ?q=, keeping filters and resetting the page", () => {
    vi.useFakeTimers();
    try {
      render(<ProfilesSearch q="" />);
      fireEvent.change(screen.getByLabelText(/Search name or CWID/), {
        target: { value: "harrington" },
      });
      expect(replace).not.toHaveBeenCalled(); // debounced
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(lastUrl()).toContain("q=harrington");
      expect(lastUrl()).toContain("type=postdoc");
      expect(lastUrl()).not.toContain("page=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the search immediately on Enter", () => {
    const { container } = render(<ProfilesSearch q="" />);
    fireEvent.change(screen.getByLabelText(/Search name or CWID/), { target: { value: "silver" } });
    fireEvent.submit(container.querySelector("form")!);
    expect(lastUrl()).toContain("q=silver");
  });
});

describe("ProfilesFilters — misc", () => {

  it("Clear navigates back to the unfiltered route", () => {
    renderFilters();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(replace).toHaveBeenLastCalledWith("/edit/profiles", { scroll: false });
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
