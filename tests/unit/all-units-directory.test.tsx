/**
 * #971 UI — `AllUnitsDirectory`, the complete org-unit listing on `/edit/units`
 * for superusers + comms stewards. Native DOM assertions (no jest-dom in
 * `tests/setup.ts`): toBeTruthy()/toBeNull() + a local href getter.
 *
 * The component has no router.push of its own — the whole row is clickable via a
 * stretched `<Link>` in the unit cell, never an onClick — so `next/navigation`
 * is mocked only harmlessly in case a child needs it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { AllUnitsDirectory } from "@/components/edit/all-units-directory";
import type { UnitDirectoryEntry } from "@/lib/edit/manageable-units";

const href = (el: HTMLElement) => el.getAttribute("href");

const curatedDept: UnitDirectoryEntry = {
  kind: "department",
  code: "N1280",
  name: "Library",
  officialName: "Samuel J. Wood Library",
  compactName: "Library",
  description: "The medical library.",
  slug: "library",
  kindLabel: "Department",
  category: "administrative",
  centerType: null,
  leaderCwid: "abc1234",
  leaderName: "Jane Chair",
  leaderInterim: false,
  scholarCount: 5,
  source: "ED",
  parentDeptCode: null,
  parentDeptName: null,
  sortOrder: null,
  retired: false,
  href: "/edit/department/N1280",
};

const degradedDivision: UnitDirectoryEntry = {
  kind: "division",
  code: "D-CARD",
  name: "Cardiology",
  officialName: "Cardiology", // degraded: official=compact=name
  compactName: "Cardiology",
  description: null,
  slug: "cardiology",
  kindLabel: "Division",
  category: null,
  centerType: null,
  leaderCwid: null,
  leaderName: null,
  leaderInterim: false,
  scholarCount: 2,
  source: "ED",
  parentDeptCode: "N1280",
  parentDeptName: "Medicine",
  sortOrder: null,
  retired: false,
  href: "/edit/division/D-CARD",
};

const interimCenter: UnitDirectoryEntry = {
  kind: "center",
  code: "man-onc",
  name: "Cancer Center",
  officialName: "Cancer Center",
  compactName: "Cancer Center",
  description: "Oncology.",
  slug: "cancer",
  kindLabel: "Center",
  category: null,
  centerType: "institute",
  leaderCwid: "dir9999",
  leaderName: "Acting Director",
  leaderInterim: true,
  scholarCount: 9,
  source: "seed",
  parentDeptCode: null,
  parentDeptName: null,
  sortOrder: 1,
  retired: false,
  href: "/edit/center/man-onc",
};

const retiredCenter: UnitDirectoryEntry = {
  ...interimCenter,
  code: "man-old",
  name: "Old Center",
  officialName: "Old Center",
  compactName: "Old Center",
  leaderName: "Some Director",
  leaderInterim: false,
  centerType: "center",
  retired: true,
  sortOrder: 2,
  href: "/edit/center/man-old",
};

const fakeCore: UnitDirectoryEntry = {
  ...degradedDivision,
  kind: "core",
  code: "7",
  name: "Test Core",
  officialName: "Test Core",
  compactName: "Test Core",
  kindLabel: "Core",
  scholarCount: 0,
  source: "reciterai-core-dictionary",
  parentDeptCode: null,
  parentDeptName: null,
  href: "/edit/core/7",
};

const allFour = [curatedDept, degradedDivision, interimCenter, retiredCenter];

const rowIds = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('[data-testid^="all-units-row-"]')).map((el) =>
    el.getAttribute("data-testid"),
  );

describe("AllUnitsDirectory", () => {
  it("renders one row per unit with the editor href", () => {
    // The editor href lives on the unit-name anchor, which stretches over the row.
    render(<AllUnitsDirectory units={allFour} />);
    expect(href(screen.getByTestId("all-units-edit-department-N1280"))).toBe(
      "/edit/department/N1280",
    );
    expect(href(screen.getByTestId("all-units-edit-division-D-CARD"))).toBe(
      "/edit/division/D-CARD",
    );
    expect(href(screen.getByTestId("all-units-edit-center-man-onc"))).toBe("/edit/center/man-onc");
    expect(href(screen.getByTestId("all-units-edit-center-man-old"))).toBe("/edit/center/man-old");
  });

  it("shows officialName as the row's link, with compactName, type and source under it", () => {
    render(<AllUnitsDirectory units={[curatedDept]} />);
    const row = screen.getByTestId("all-units-row-department-N1280");
    expect(row.textContent).toContain("Samuel J. Wood Library");
    expect(row.textContent).toContain("Library · Administrative · Enterprise Directory");
    expect(row.textContent).toContain("N1280");
    expect(screen.getByTestId("all-units-scholars-department-N1280").textContent).toBe("5");
  });

  it("puts the scholar count in a right-aligned tabular-nums cell, muted at zero", () => {
    render(<AllUnitsDirectory units={[...allFour, fakeCore]} />);
    const cell = screen.getByTestId("all-units-scholars-center-man-onc");
    expect(cell.tagName).toBe("TD");
    expect(cell.className).toContain("text-right");
    expect(cell.className).toContain("tabular-nums");
    expect(cell.textContent).toBe("9");
    expect(screen.getByTestId("all-units-scholars-core-7").className).toContain(
      "text-muted-foreground",
    );
  });

  it("leads a division's name with its parent department", () => {
    render(<AllUnitsDirectory units={[degradedDivision]} />);
    const row = screen.getByTestId("all-units-row-division-D-CARD");
    expect(row.textContent).toContain("Medicine ›");
    expect(row.textContent).toContain("Cardiology");
  });

  it("flags gap markers for a null-leader / null-description unit, none for a curated one", () => {
    render(<AllUnitsDirectory units={[curatedDept, degradedDivision]} />);
    expect(screen.getByTestId("all-units-gap-division-D-CARD-leader")).toBeTruthy();
    expect(screen.getByTestId("all-units-gap-division-D-CARD-description")).toBeTruthy();
    expect(screen.queryByTestId("all-units-gap-department-N1280-leader")).toBeNull();
    expect(screen.queryByTestId("all-units-gap-department-N1280-description")).toBeNull();
  });

  it("Desc. column reads an amber 'Missing' pill, or a slate '✓ Written' when present", () => {
    render(<AllUnitsDirectory units={[curatedDept, degradedDivision]} />);
    const missing = screen.getByTestId("all-units-gap-division-D-CARD-description");
    expect(missing.textContent).toBe("Missing");
    expect(missing.className).toContain("text-apollo-amber");
    expect(missing.className).toContain("bg-apollo-amber-tint");

    const present = screen.getByTestId("all-units-has-department-N1280-description");
    expect(present.textContent).toBe("✓ Written");
    expect(present.className).toContain("text-apollo-slate");
    // The description itself survives as the mark's tooltip.
    expect(present.getAttribute("title")).toBe("The medical library.");
  });

  it("a missing leader reads 'No leader' in muted ink", () => {
    render(<AllUnitsDirectory units={[degradedDivision]} />);
    const gap = screen.getByTestId("all-units-gap-division-D-CARD-leader");
    expect(gap.textContent).toBe("No leader");
    expect(gap.className).toContain("text-muted-foreground");
  });

  it("makes the row clickable with a stretched anchor, not a row handler", () => {
    render(<AllUnitsDirectory units={[curatedDept]} />);
    const row = screen.getByTestId("all-units-row-department-N1280");
    expect(row.tagName).toBe("TR");
    expect(row.className).toContain("relative");
    expect(row.className).toContain("hover:bg-apollo-page");
    expect(row.className).toContain("focus-within:outline-apollo-maroon");

    const anchor = screen.getByTestId("all-units-edit-department-N1280");
    expect(anchor.tagName).toBe("A");
    expect(anchor.className).toContain("after:absolute");
    expect(anchor.className).toContain("after:inset-0");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
  });

  it("keeps the Web Directory code link above the stretched anchor", () => {
    render(<AllUnitsDirectory units={[curatedDept]} />);
    const codeLink = screen.getByTestId("all-units-code-link-N1280");
    expect(codeLink.className).toContain("relative");
    expect(codeLink.className).toContain("z-10");
  });

  it("renders a real table sectioned by kind, with collapsible section headers", () => {
    const { container } = render(<AllUnitsDirectory units={[...allFour, fakeCore]} />);
    expect(screen.getByTestId("all-units-table").tagName).toBe("TABLE");
    for (const g of ["departments", "divisions", "centers", "cores"]) {
      expect(screen.getByTestId(`all-units-group-${g}`)).toBeTruthy();
    }
    const groupHeader = screen
      .getByTestId("all-units-group-departments")
      .querySelector("th[scope='colgroup']");
    expect(groupHeader?.getAttribute("colspan")).toBe("6");
    expect(groupHeader?.textContent).toContain("Departments");
    // The section's own gap tally.
    expect(screen.getByTestId("all-units-section-division").textContent).toContain(
      "1 no description · 1 no leader",
    );
    const heads = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(heads).toEqual(["Unit", "Code", "Scholars", "Leader", "Desc.", "Open"]);

    const toggle = screen.getByTestId("all-units-section-division");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("all-units-row-division-D-CARD")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
  });

  it("shows an empty state (not a header-only table) when nothing matches", () => {
    render(<AllUnitsDirectory units={allFour} />);
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "zzzznope" } });
    expect(screen.queryByTestId("all-units-table")).toBeNull();
    expect(screen.getByTestId("all-units-empty").textContent).toBe("No units match these filters.");
    expect(screen.getByTestId("all-units-filter")).toBeTruthy();
  });

  it("renders the Retired pill only on the retired unit", () => {
    render(<AllUnitsDirectory units={allFour} />);
    expect(screen.getByTestId("all-units-retired-center-man-old")).toBeTruthy();
    expect(screen.queryByTestId("all-units-retired-center-man-onc")).toBeNull();
  });

  it("filter input narrows the visible rows and the stats line", () => {
    render(<AllUnitsDirectory units={allFour} />);
    expect(screen.getByTestId("all-units-stat-units").textContent).toBe("4 units");
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "cardio" } });
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
    expect(screen.getByTestId("all-units-stat-units").textContent).toBe("1 units");
  });

  it("renders 'Interim' before a center's interim director", () => {
    render(<AllUnitsDirectory units={[interimCenter]} />);
    const row = screen.getByTestId("all-units-row-center-man-onc");
    expect(row.textContent).toContain("Interim Acting Director");
  });

  it("filter also matches by leader name", () => {
    render(<AllUnitsDirectory units={allFour} />);
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "jane" } });
    expect(screen.getByTestId("all-units-row-department-N1280")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-division-D-CARD")).toBeNull();
  });

  it("'Most scholars' sorts within each kind section, keeping the sections", () => {
    const bigDept = {
      ...curatedDept,
      code: "N9999",
      officialName: "Zymology",
      scholarCount: 50,
      href: "/edit/department/N9999",
    };
    const { container } = render(<AllUnitsDirectory units={[...allFour, bigDept]} />);
    expect(rowIds(container).slice(0, 2)).toEqual([
      "all-units-row-department-N1280", // "Samuel…" before "Zymology" by name
      "all-units-row-department-N9999",
    ]);
    fireEvent.click(screen.getByTestId("all-units-sort-scholars"));
    expect(screen.getByTestId("all-units-sort-scholars").getAttribute("aria-pressed")).toBe("true");
    expect(rowIds(container)).toEqual([
      "all-units-row-department-N9999", // 50
      "all-units-row-department-N1280", // 5
      "all-units-row-division-D-CARD",
      "all-units-row-center-man-onc", // 9, name tiebreak
      "all-units-row-center-man-old", // 9
    ]);
    expect(screen.getByTestId("all-units-group-departments")).toBeTruthy();
  });

  it("Gap 'No description' narrows to undescribed units, with counts on each option", () => {
    render(<AllUnitsDirectory units={allFour} />);
    expect(screen.getByTestId("all-units-gap-any-rail").textContent).toContain("4");
    expect(screen.getByTestId("all-units-gap-desc-rail").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("all-units-gap-desc-rail"));
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
    expect(screen.queryByTestId("all-units-row-center-man-onc")).toBeNull();
  });

  it("Gap 'No leader' and 'Both missing' narrow to leaderless units", () => {
    render(<AllUnitsDirectory units={allFour} />);
    fireEvent.click(screen.getByTestId("all-units-gap-lead-rail"));
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
    fireEvent.click(screen.getByTestId("all-units-gap-both-rail"));
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.getByTestId("all-units-stat-units").textContent).toBe("1 units");
  });

  it("Kind, Type and Source facets narrow the list; Clear resets everything", () => {
    const { container } = render(<AllUnitsDirectory units={[...allFour, fakeCore]} />);
    fireEvent.click(screen.getByTestId("all-units-facet-kinds-center-rail"));
    expect(rowIds(container)).toEqual([
      "all-units-row-center-man-onc",
      "all-units-row-center-man-old",
    ]);
    fireEvent.click(screen.getByTestId("all-units-clear-rail"));
    expect(rowIds(container)).toHaveLength(5);

    fireEvent.click(screen.getByTestId("all-units-facet-types-Institute-rail"));
    expect(rowIds(container)).toEqual(["all-units-row-center-man-onc"]);
    fireEvent.click(screen.getByTestId("all-units-clear-rail"));

    fireEvent.click(screen.getByTestId("all-units-facet-sources-ReciterAI core dictionary-rail"));
    expect(rowIds(container)).toEqual(["all-units-row-core-7"]);
  });

  it("labels source codes in plain words", () => {
    render(<AllUnitsDirectory units={[curatedDept, interimCenter, fakeCore]} />);
    expect(screen.getByTestId("all-units-row-department-N1280").textContent).toContain(
      "Enterprise Directory",
    );
    expect(screen.getByTestId("all-units-row-center-man-onc").textContent).toContain(
      "Institute · Seed",
    );
    expect(screen.getByTestId("all-units-row-core-7").textContent).toContain(
      "ReciterAI core dictionary",
    );
  });

  it("links a WCM org-unit code to the Web Directory, but leaves a center slug plain", () => {
    render(<AllUnitsDirectory units={[curatedDept, interimCenter]} />);
    expect(href(screen.getByTestId("all-units-code-link-N1280"))).toBe(
      "https://directory.weill.cornell.edu/orgunits/N1280",
    );
    expect(screen.queryByTestId("all-units-code-link-man-onc")).toBeNull();
  });

  it("renders the 'All units' heading only when asked", () => {
    const { rerender } = render(<AllUnitsDirectory units={[curatedDept]} />);
    expect(screen.queryByRole("heading", { name: "All units" })).toBeNull();
    rerender(<AllUnitsDirectory units={[curatedDept]} heading />);
    expect(screen.getByRole("heading", { name: "All units" })).toBeTruthy();
  });
});
