/**
 * Render tests for the /browse hub redesign (Departments & Centers v2 mock):
 * department rows (scholar-count column, leader fallback, badge tokens,
 * expand toggle, name filter incl. leader, empty state), center cards, and
 * the anchor strip's scroll-spy. Assertions are scoped to each rendered
 * container, never document.body.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { BrowseCenter, BrowseDepartment } from "@/lib/api/browse";

vi.mock("next/navigation", () => ({
  usePathname: () => "/browse",
  useSearchParams: () => new URLSearchParams(""),
}));

import { DepartmentsGrid } from "@/components/browse/departments-grid";
import { CentersGrid } from "@/components/browse/centers-grid";
import { BrowseAnchorStrip } from "@/components/browse/browse-anchor-strip";

afterEach(cleanup);

function dept(over: Partial<BrowseDepartment>): BrowseDepartment {
  return {
    code: "D1",
    name: "Medicine",
    officialName: null,
    compactName: null,
    slug: "medicine",
    category: "clinical",
    scholarCount: 2652,
    chairName: "Myles Wolf",
    chairSlug: "myles-wolf",
    chairLabel: "Chair",
    divisions: [
      { code: "V1", name: "Cardiology", slug: "cardiology" },
      { code: "V2", name: "Nephrology", slug: "nephrology" },
    ],
    topResearchAreas: [
      { topicId: "t1", topicSlug: "epi", topicLabel: "Epidemiology" },
    ],
    ...over,
  };
}

const DEPTS: BrowseDepartment[] = [
  dept({}),
  dept({
    code: "D2",
    name: "Library",
    slug: "library",
    category: "administrative",
    scholarCount: 0,
    chairName: null,
    chairSlug: null,
    chairLabel: null,
    divisions: [],
    topResearchAreas: [],
  }),
  dept({
    code: "D3",
    name: "Pharmacology",
    slug: "pharmacology",
    category: "basic",
    scholarCount: 1,
    chairName: "Robin T Chairperson",
    divisions: [],
    topResearchAreas: [],
  }),
];

function rowFor(container: HTMLElement, name: string): HTMLElement {
  const rows = within(container).getAllByTestId("dept-row");
  const row = rows.find((r) => within(r).queryByRole("link", { name }));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("DepartmentsGrid (v2)", () => {
  it("renders a formatted scholar count and blank cell for zero", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const med = rowFor(container, "Medicine");
    expect(within(med).getByTestId("dept-scholar-count").textContent).toBe(
      "2,652 scholars",
    );
    expect(within(med).getByTestId("dept-division-count").textContent).toBe(
      "2 divisions",
    );
    const lib = rowFor(container, "Library");
    expect(within(lib).getByTestId("dept-scholar-count").textContent).toBe("");
    expect(within(lib).getByTestId("dept-division-count").textContent).toBe("");
    const pharm = rowFor(container, "Pharmacology");
    expect(within(pharm).getByTestId("dept-scholar-count").textContent).toBe(
      "1 scholar",
    );
  });

  it("shows the leader without a colon, or 'Leadership not listed'", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const med = rowFor(container, "Medicine");
    expect(med.textContent).toContain("ChairMyles Wolf");
    expect(med.textContent).not.toContain("Chair:");
    const lib = rowFor(container, "Library");
    expect(within(lib).getByText("Leadership not listed")).toBeTruthy();
  });

  it("uses Apollo token classes for type badges (no hex, basic is neutral)", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const clinical = within(rowFor(container, "Medicine")).getByText("Clinical");
    expect(clinical.className).toContain("bg-apollo-slate-tint");
    expect(clinical.className).toContain("text-apollo-slate");
    const basic = within(rowFor(container, "Pharmacology")).getByText(
      "Basic Science",
    );
    expect(basic.className).toContain("bg-apollo-surface-2");
    expect(basic.className).toContain("text-apollo-bar");
    expect(basic.className).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("every row is expandable; the toggle flips aria-expanded and reveals the panel", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const lib = rowFor(container, "Library");
    const toggle = within(lib).getByRole("button", { name: /Expand Library/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = container.querySelector<HTMLElement>(
      `[id="${toggle.getAttribute("aria-controls")}"]`,
    )!;
    expect(panel.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(within(panel).getByRole("link", { name: /View Library/ })).toBeTruthy();
  });

  it("a click on the row body toggles; a click on the name link does not", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const med = rowFor(container, "Medicine");
    const toggle = within(med).getByRole("button", { name: /Medicine/ });
    // jsdom can't navigate; keep the link click from trying.
    container.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(within(med).getByTestId("dept-scholar-count"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(within(med).getByRole("link", { name: "Medicine" }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("name filter matches the leader's name and recomputes type counts", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const input = within(container).getByRole("searchbox", {
      name: "Filter departments",
    });
    fireEvent.change(input, { target: { value: "chairperson" } });
    expect(within(container).getAllByTestId("dept-row")).toHaveLength(1);
    expect(within(container).getByText("1 of 3 departments")).toBeTruthy();
    const clinicalPill = within(container).getByRole("button", {
      name: /^Clinical/,
    });
    expect(clinicalPill.textContent).toBe("Clinical0");
  });

  it("empty state reads 'No departments match.' with a Clear filters button", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const input = within(container).getByRole("searchbox", {
      name: "Filter departments",
    });
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(within(container).getByText(/No departments match\./)).toBeTruthy();
    fireEvent.click(within(container).getByRole("button", { name: "Clear filters" }));
    expect(within(container).getAllByTestId("dept-row")).toHaveLength(3);
  });

  it("active pills use the slate fill", () => {
    const { container } = render(<DepartmentsGrid departments={DEPTS} />);
    const nameSort = within(container).getByRole("button", { name: "Name (A–Z)" });
    expect(nameSort.getAttribute("aria-pressed")).toBe("true");
    expect(nameSort.className).toContain("bg-apollo-slate");
  });
});

describe("CentersGrid (v2)", () => {
  const center: BrowseCenter = {
    code: "C1",
    name: "Meyer Cancer Center",
    slug: "meyer",
    description: "Cancer research.",
    directorName: "Jedd Wolchok",
    directorSlug: null,
    scholarCount: 1320,
    sortOrder: 1,
  };

  it("renders the footer as '<count> members · Director <name>' without a colon", () => {
    const { container } = render(<CentersGrid centers={[center]} />);
    const footer = within(container).getByTestId("center-card-footer");
    expect(footer.textContent).toBe("1,320 members·DirectorJedd Wolchok");
    expect(footer.textContent).not.toContain("Director:");
  });

  it("singularizes a lone member and omits the footer with no data", () => {
    const { container } = render(
      <CentersGrid
        centers={[
          { ...center, code: "C2", scholarCount: 1, directorName: null },
          { ...center, code: "C3", scholarCount: 0, directorName: null },
        ]}
      />,
    );
    const footers = within(container).getAllByTestId("center-card-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0].textContent).toBe("1 member");
  });
});

describe("BrowseAnchorStrip scroll-spy", () => {
  function section(id: string, top: number) {
    const el = document.createElement("section");
    el.dataset.spy = id;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
    return el;
  }

  it("defaults to Departments and follows the last section above the threshold", () => {
    const host = document.createElement("div");
    const dep = section("departments", 400);
    const cen = section("centers", 900);
    host.append(dep, cen);
    document.body.append(host);
    try {
      const { container } = render(<BrowseAnchorStrip showCores={false} />);
      const nav = within(container).getByRole("navigation", {
        name: "Browse sections",
      });
      expect(
        within(nav).getByRole("link", { name: "Departments" }).getAttribute("aria-current"),
      ).toBe("true");
      expect(within(nav).queryByRole("link", { name: "Core Facilities" })).toBeNull();

      dep.getBoundingClientRect = () => ({ top: -500 }) as DOMRect;
      cen.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });
      expect(
        within(nav)
          .getByRole("link", { name: "Centers & Institutes" })
          .getAttribute("aria-current"),
      ).toBe("true");
      expect(
        within(nav).getByRole("link", { name: "Departments" }).getAttribute("aria-current"),
      ).toBeNull();
    } finally {
      host.remove();
    }
  });

  it("shows the Core Facilities tab when cores exist", () => {
    const { container } = render(<BrowseAnchorStrip showCores />);
    expect(within(container).getByRole("link", { name: "Core Facilities" })).toBeTruthy();
  });
});
