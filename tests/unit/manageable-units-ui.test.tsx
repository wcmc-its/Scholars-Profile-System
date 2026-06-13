/**
 * #753 UI — the "Units you manage" surfaces:
 *   - `ManageableUnitsIndex` (the `/edit/units` body): grouping, owner-only
 *     "Add a center", non-superuser empty state, superuser finder + create, and
 *     finder navigation.
 *   - `HomePanel`'s units section: presence gate, edit links, and the cap.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockPush } = vi.hoisted(() => ({ mockPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { ManageableUnitsIndex } from "@/components/edit/manageable-units-index";
import { HomePanel } from "@/components/edit/home-panel";
import type { ManageableUnit, ManageableUnits } from "@/lib/edit/manageable-units";

beforeEach(() => mockPush.mockReset());

const deptOwner: ManageableUnit = {
  kind: "department",
  code: "N1280",
  name: "Medicine",
  role: "owner",
  href: "/edit/department/N1280",
};
const divCurator: ManageableUnit = {
  kind: "division",
  code: "D-CARD",
  name: "Cardiology",
  role: "curator",
  href: "/edit/division/D-CARD",
};
const centerOwner: ManageableUnit = {
  kind: "center",
  code: "man-onc",
  name: "Cancer Center",
  role: "owner",
  href: "/edit/center/man-onc",
};

function mkUnits(list: ManageableUnit[]): ManageableUnits {
  return {
    departments: list.filter((u) => u.kind === "department"),
    divisions: list.filter((u) => u.kind === "division"),
    centers: list.filter((u) => u.kind === "center"),
    total: list.length,
  };
}

const href = (el: HTMLElement) => el.getAttribute("href");

describe("ManageableUnitsIndex", () => {
  it("non-superuser with grants: groups, edit links, owner 'Add a center', no superuser tools", () => {
    render(
      <ManageableUnitsIndex
        units={mkUnits([deptOwner, divCurator, centerOwner])}
        isSuperuser={false}
      />,
    );
    expect(href(screen.getByTestId("units-edit-department-N1280"))).toBe("/edit/department/N1280");
    expect(href(screen.getByTestId("units-edit-division-D-CARD"))).toBe("/edit/division/D-CARD");
    expect(href(screen.getByTestId("units-edit-center-man-onc"))).toBe("/edit/center/man-onc");
    // Owner of a department → can add a center under it.
    expect(href(screen.getByTestId("units-add-center-N1280"))).toBe(
      "/edit/unit/new?type=center&dept=N1280",
    );
    expect(screen.queryByTestId("units-superuser-tools")).toBeNull();
    expect(screen.queryByTestId("units-empty")).toBeNull();
  });

  it("does not offer 'Add a center' on a department the actor only curates", () => {
    const deptCurator = { ...deptOwner, role: "curator" as const };
    render(<ManageableUnitsIndex units={mkUnits([deptCurator])} isSuperuser={false} />);
    expect(screen.queryByTestId("units-add-center-N1280")).toBeNull();
  });

  it("non-superuser with no grants shows the empty state", () => {
    render(<ManageableUnitsIndex units={mkUnits([])} isSuperuser={false} />);
    expect(screen.getByTestId("units-empty")).toBeTruthy();
    expect(screen.queryByTestId("units-superuser-tools")).toBeNull();
  });

  it("superuser with no grants: no empty state and no finder/create in this body", () => {
    // The finder + "Create a unit" moved to AllUnitsDirectory (#971); a superuser
    // with no direct grants sees neither here, and is not shown the empty state
    // (canFindAnyUnit defaults to isSuperuser).
    render(<ManageableUnitsIndex units={mkUnits([])} isSuperuser />);
    expect(screen.queryByTestId("units-empty")).toBeNull();
    expect(screen.queryByTestId("units-superuser-tools")).toBeNull();
    expect(screen.queryByTestId("units-create")).toBeNull();
  });
});

describe("HomePanel — units section", () => {
  const base = {
    basePath: "/edit",
    preferredName: "Jane Doe",
    identityImageEndpoint: "",
    hasBio: true,
    isHidden: false,
    totalPublications: 3,
    hiddenPublications: 0,
  };

  it("omits the section entirely when a non-superuser manages no units", () => {
    render(<HomePanel {...base} />);
    expect(screen.queryByTestId("home-units")).toBeNull();
  });

  it("shows a superuser the manage link even with no explicit grants", () => {
    render(<HomePanel {...base} isSuperuser manageableUnits={[]} />);
    expect(screen.getByTestId("home-units")).toBeTruthy();
    expect(screen.getByTestId("home-units-superuser-hint")).toBeTruthy();
    expect(href(screen.getByTestId("home-units-manage"))).toBe("/edit/units");
    expect(screen.queryByTestId("home-unit-edit-department-N1280")).toBeNull();
  });

  it("lists managed units with edit links and a 'Manage units' link", () => {
    render(<HomePanel {...base} manageableUnits={[deptOwner, divCurator]} />);
    expect(screen.getByTestId("home-units")).toBeTruthy();
    expect(href(screen.getByTestId("home-unit-edit-department-N1280"))).toBe(
      "/edit/department/N1280",
    );
    const manage = screen.getByTestId("home-units-manage");
    expect(href(manage)).toBe("/edit/units");
    expect(manage.textContent).toContain("Manage units");
  });

  it("caps the list at six and links through to the full index when there are more", () => {
    const many: ManageableUnit[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "center" as const,
      code: `c${i}`,
      name: `Center ${i}`,
      role: "owner" as const,
      href: `/edit/center/c${i}`,
    }));
    render(<HomePanel {...base} manageableUnits={many} />);
    expect(screen.getByTestId("home-unit-center-c5")).toBeTruthy(); // 6th shown
    expect(screen.queryByTestId("home-unit-center-c6")).toBeNull(); // 7th hidden
    expect(screen.getByTestId("home-units-manage").textContent).toContain("View all 8 units");
  });
});
