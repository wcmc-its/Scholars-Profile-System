/**
 * `components/edit/coi-filters.tsx` — the COI dashboard's client filter
 * island (`/edit/coi`, superuser-only). A trimmed sibling of
 * `components/edit/profiles-filters.tsx`: same auto-apply idiom (facet
 * toggle / select / hidden-roles checkbox / debounced search all navigate via
 * `router.replace`, no "Apply" button), but the only "Gap" option is COI
 * itself — no headshot/overview options (those never existed here), and no
 * overview-freshness filter at all. There is no `canSeeCoi`-equivalent prop:
 * page-level auth (`app/edit/coi/page.tsx`) already gates the whole surface.
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
}));

import { CoiFilters } from "@/components/edit/coi-filters";

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
    <CoiFilters
      facets={facets as never}
      roleCategories={["postdoc"]}
      units={["dept:MED"]}
      q=""
      gap="all"
      includeHidden={true}
      {...over}
    />,
  );
}

const lastUrl = () => String(replace.mock.calls.at(-1)?.[0] ?? "");

beforeEach(() => vi.clearAllMocks());

describe("CoiFilters — auto-apply", () => {
  it("has no Apply button", () => {
    renderFilters();
    expect(screen.queryByRole("button", { name: /apply/i })).toBeNull();
  });

  it("navigates on facet toggle, carrying the full selection as repeated params", () => {
    renderFilters({ roleCategories: [] });
    fireEvent.click(screen.getByText("Full-time faculty"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toContain("type=full_time_faculty");
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

  it("the Gap select offers ONLY Any/Has COI to review — no headshot/overview options", () => {
    renderFilters();
    const select = screen.getByLabelText("Gap") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["all", "has-coi"]);
    fireEvent.change(select, { target: { value: "has-coi" } });
    expect(lastUrl()).toContain("gap=has-coi");
  });

  it("has no overview-freshness filter at all", () => {
    renderFilters();
    expect(screen.queryByLabelText("Overview last updated")).toBeNull();
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

  it("Clear navigates back to the unfiltered /edit/coi route", () => {
    renderFilters();
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(replace).toHaveBeenLastCalledWith("/edit/coi", { scroll: false });
  });
});
