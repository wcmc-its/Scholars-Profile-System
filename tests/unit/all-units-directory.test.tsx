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

const allFour = [curatedDept, degradedDivision, interimCenter, retiredCenter];

describe("AllUnitsDirectory", () => {
  it("renders one row per unit with the editor href", () => {
    // The editor href now lives on the unit-name anchor (which stretches over
    // the whole row) rather than a trailing "Edit →" link column.
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    expect(href(screen.getByTestId("all-units-edit-department-N1280"))).toBe(
      "/edit/department/N1280",
    );
    expect(href(screen.getByTestId("all-units-edit-division-D-CARD"))).toBe(
      "/edit/division/D-CARD",
    );
    expect(href(screen.getByTestId("all-units-edit-center-man-onc"))).toBe("/edit/center/man-onc");
    expect(href(screen.getByTestId("all-units-edit-center-man-old"))).toBe("/edit/center/man-old");
  });

  // Was "…scholarCount in meta": the card's "· 5 scholars ·" meta line is gone,
  // so the count is asserted on its own right-aligned cell instead.
  it("shows officialName as the row's link, with compactName/code in the unit cell", () => {
    render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-department-N1280");
    expect(row.textContent).toContain("Samuel J. Wood Library");
    expect(row.textContent).toContain("Library"); // compact, differs from official
    expect(row.textContent).toContain("N1280");
    expect(screen.getByTestId("all-units-scholars-department-N1280").textContent).toBe("5");
  });

  it("puts the scholar count in a right-aligned tabular-nums cell", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    const cell = screen.getByTestId("all-units-scholars-center-man-onc");
    expect(cell.tagName).toBe("TD");
    expect(cell.className).toContain("text-right");
    expect(cell.className).toContain("tabular-nums");
    expect(cell.textContent).toBe("9");
  });

  it("division degrades gracefully — heading falls back to name, parent dept shown above", () => {
    render(<AllUnitsDirectory units={[degradedDivision]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-division-D-CARD");
    expect(row.textContent).toContain("Cardiology");
    // Parent department rides above the name as a muted eyebrow (no "in" prefix).
    expect(row.textContent).toContain("Medicine");
  });

  // Was "…gap pills": the pills became columns. The leader gap is an em dash in
  // the Leader cell and the description gap is the word "Missing" in the
  // Description cell, but the same markers identify them.
  it("flags gap markers for a null-leader / null-description unit, none for a curated one", () => {
    render(<AllUnitsDirectory units={[curatedDept, degradedDivision]} isSuperuser />);
    // Degraded division: no leader, no description.
    expect(screen.getByTestId("all-units-gap-division-D-CARD-leader")).toBeTruthy();
    expect(screen.getByTestId("all-units-gap-division-D-CARD-description")).toBeTruthy();
    // A missing official name is NOT a gap — that marker no longer exists, even
    // for the degraded division whose official name falls back to its name.
    expect(screen.queryByTestId("all-units-gap-division-D-CARD-official")).toBeNull();
    // Fully-curated dept: no gap markers at all.
    expect(screen.queryByTestId("all-units-gap-department-N1280-leader")).toBeNull();
    expect(screen.queryByTestId("all-units-gap-department-N1280-description")).toBeNull();
  });

  it("Description column reads 'Missing' in maroon, or a green check when present", () => {
    render(<AllUnitsDirectory units={[curatedDept, degradedDivision]} isSuperuser />);
    const missing = screen.getByTestId("all-units-gap-division-D-CARD-description");
    expect(missing.textContent).toBe("Missing");
    expect(missing.className).toContain("text-apollo-maroon");

    const present = screen.getByTestId("all-units-has-department-N1280-description");
    expect(present.textContent).toContain("✓");
    // The token, not a stray Tailwind palette green.
    expect(present.className).toContain("text-apollo-green");
    expect(present.className).not.toContain("emerald");
    // The description itself survives as the check's tooltip.
    expect(present.getAttribute("title")).toBe("The medical library.");
  });

  it("a missing leader shows an em dash, not an empty cell", () => {
    render(<AllUnitsDirectory units={[degradedDivision]} isSuperuser />);
    const gap = screen.getByTestId("all-units-gap-division-D-CARD-leader");
    expect(gap.textContent).toContain("—");
    expect(gap.className).toContain("text-muted-foreground");
    // …and screen readers still get words rather than punctuation.
    expect(gap.textContent).toContain("No leader");
  });

  it("makes the row clickable with a stretched anchor, not a row handler", () => {
    render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-department-N1280");
    expect(row.tagName).toBe("TR");
    expect(row.className).toContain("relative");
    expect(row.className).toContain("hover:bg-apollo-surface-2");
    expect(row.className).toContain("focus-within:outline-apollo-maroon");

    const anchor = screen.getByTestId("all-units-edit-department-N1280");
    expect(anchor.tagName).toBe("A");
    expect(anchor.className).toContain("after:absolute");
    expect(anchor.className).toContain("after:inset-0");
    // A real link, never role="button" + keydown — cmd-click / middle-click /
    // "copy link address" must keep working.
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
  });

  it("keeps the Web Directory code link above the stretched anchor", () => {
    render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    const codeLink = screen.getByTestId("all-units-code-link-N1280");
    // Without `relative z-10` the row's stretched anchor paints over this link
    // and swallows the click — the classic way this pattern ships broken.
    expect(codeLink.className).toContain("relative");
    expect(codeLink.className).toContain("z-10");
  });

  it("renders a real table with a group header row spanning every column", () => {
    const { container } = render(<AllUnitsDirectory units={allFour} isSuperuser />);
    expect(screen.getByTestId("all-units-table").tagName).toBe("TABLE");
    // The three kind groups survive as <tbody> sections.
    expect(screen.getByTestId("all-units-group-departments")).toBeTruthy();
    expect(screen.getByTestId("all-units-group-divisions")).toBeTruthy();
    expect(screen.getByTestId("all-units-group-centers")).toBeTruthy();
    const groupHeader = screen
      .getByTestId("all-units-group-departments")
      .querySelector("th[scope='colgroup']");
    expect(groupHeader?.getAttribute("colspan")).toBe("6");
    expect(groupHeader?.textContent).toBe("Departments");
    // Six column headers, Description last.
    const heads = Array.from(container.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(heads).toEqual(["Unit", "Kind", "Code", "Scholars", "Leader", "Description"]);
  });

  it("renders no table at all when nothing matches the filter", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "zzzznope" } });
    expect(screen.queryByTestId("all-units-table")).toBeNull();
    // The filter bar itself stays, so the reader can undo the filter.
    expect(screen.getByTestId("all-units-filter")).toBeTruthy();
  });

  it("renders the Retired pill only on the retired unit", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    expect(screen.getByTestId("all-units-retired-center-man-old")).toBeTruthy();
    expect(screen.queryByTestId("all-units-retired-center-man-onc")).toBeNull();
  });

  it("filter input narrows the visible rows", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    // All four present before filtering.
    expect(screen.getByTestId("all-units-row-department-N1280")).toBeTruthy();
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "cardio" } });
    // Cardiology matches; the library dept does not.
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
  });

  it("renders 'Interim' before a center's interim director", () => {
    render(<AllUnitsDirectory units={[interimCenter]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-center-man-onc");
    expect(row.textContent).toContain("Interim Acting Director");
  });

  it("filter also matches by leader name", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    fireEvent.change(screen.getByTestId("all-units-filter"), { target: { value: "jane" } });
    expect(screen.getByTestId("all-units-row-department-N1280")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-division-D-CARD")).toBeNull();
  });

  it("'Sort by scholars' orders by scholar count, most first, as a flat list", () => {
    const { container } = render(<AllUnitsDirectory units={allFour} isSuperuser />);
    fireEvent.change(screen.getByTestId("all-units-sort"), { target: { value: "scholars" } });
    const ids = Array.from(container.querySelectorAll('[data-testid^="all-units-row-"]')).map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(ids).toEqual([
      "all-units-row-center-man-onc", // 9, "Cancer Center" (name tiebreak)
      "all-units-row-center-man-old", // 9, "Old Center"
      "all-units-row-department-N1280", // 5
      "all-units-row-division-D-CARD", // 2
    ]);
    // Flat list = no kind groups.
    expect(screen.queryByTestId("all-units-group-departments")).toBeNull();
  });

  // KNOWN DEAD OPTION (pre-existing, unchanged by the table conversion): "Kind"
  // and "Name" both render the kind-grouped, name-sorted table, so the Sort
  // control has two options that produce byte-identical output. Locked here so
  // the redundancy is visible rather than folklore; removing the option is a
  // product call, not a refactor.
  it("'Sort by kind' currently produces output identical to 'Sort by name'", () => {
    const rowIds = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('[data-testid^="all-units-row-"]')).map((el) =>
        el.getAttribute("data-testid"),
      );
    const { container } = render(<AllUnitsDirectory units={allFour} isSuperuser />);
    const byName = rowIds(container);
    fireEvent.change(screen.getByTestId("all-units-sort"), { target: { value: "kind" } });
    expect(rowIds(container)).toEqual(byName);
  });

  it("'Missing description' filter narrows to undescribed units", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    fireEvent.click(screen.getByTestId("all-units-filter-missing-description"));
    // Only the degraded division lacks a description.
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
    expect(screen.queryByTestId("all-units-row-center-man-onc")).toBeNull();
  });

  it("'Missing leader' filter narrows to leaderless units", () => {
    render(<AllUnitsDirectory units={allFour} isSuperuser />);
    fireEvent.click(screen.getByTestId("all-units-filter-missing-leader"));
    expect(screen.getByTestId("all-units-row-division-D-CARD")).toBeTruthy();
    expect(screen.queryByTestId("all-units-row-department-N1280")).toBeNull();
  });

  it("labels the ED source as 'Enterprise Directory', not the raw code", () => {
    render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    expect(screen.getByTestId("all-units-row-department-N1280").textContent).toContain(
      "Enterprise Directory",
    );
  });

  it("offers 'Create a unit' to a superuser but not to a comms steward", () => {
    const { rerender } = render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    expect(screen.getByTestId("all-units-create")).toBeTruthy();
    rerender(<AllUnitsDirectory units={[curatedDept]} isSuperuser={false} />);
    expect(screen.queryByTestId("all-units-create")).toBeNull();
  });

  it("links a WCM org-unit code to the Web Directory, but leaves a center slug plain", () => {
    render(<AllUnitsDirectory units={[curatedDept, interimCenter]} isSuperuser />);
    expect(href(screen.getByTestId("all-units-code-link-N1280"))).toBe(
      "https://directory.weill.cornell.edu/orgunits/N1280",
    );
    // A center's code is a slug the Web Directory can't resolve — not linked.
    expect(screen.queryByTestId("all-units-code-link-man-onc")).toBeNull();
  });
});
