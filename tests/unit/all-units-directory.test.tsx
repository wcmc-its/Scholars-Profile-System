/**
 * #971 UI — `AllUnitsDirectory`, the complete org-unit listing on `/edit/units`
 * for superusers + comms stewards. Native DOM assertions (no jest-dom in
 * `tests/setup.ts`): toBeTruthy()/toBeNull() + a local href getter.
 *
 * The component has no router.push of its own (the Edit link is a plain anchor),
 * so `next/navigation` is mocked only harmlessly in case a child needs it.
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

  it("shows officialName as heading and compactName/code/scholarCount in meta", () => {
    render(<AllUnitsDirectory units={[curatedDept]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-department-N1280");
    expect(row.textContent).toContain("Samuel J. Wood Library");
    expect(row.textContent).toContain("Library"); // compact, differs from official
    expect(row.textContent).toContain("N1280");
    expect(row.textContent).toContain("5 scholars");
  });

  it("division degrades gracefully — heading falls back to name, shows 'in {parent}'", () => {
    render(<AllUnitsDirectory units={[degradedDivision]} isSuperuser />);
    const row = screen.getByTestId("all-units-row-division-D-CARD");
    expect(row.textContent).toContain("Cardiology");
    expect(row.textContent).toContain("in Medicine");
  });

  it("flags gap markers for a null-leader / null-description unit, none for a curated one", () => {
    render(<AllUnitsDirectory units={[curatedDept, degradedDivision]} isSuperuser />);
    // Degraded division: no leader, no description.
    expect(screen.getByTestId("all-units-gap-division-D-CARD-leader")).toBeTruthy();
    expect(screen.getByTestId("all-units-gap-division-D-CARD-description")).toBeTruthy();
    // A missing official name is NOT a gap — that marker no longer exists, even
    // for the degraded division whose official name falls back to its name.
    expect(screen.queryByTestId("all-units-gap-division-D-CARD-official")).toBeNull();
    // Fully-curated dept: no gap pills at all.
    expect(screen.queryByTestId("all-units-gap-department-N1280-leader")).toBeNull();
    expect(screen.queryByTestId("all-units-gap-department-N1280-description")).toBeNull();
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
});
