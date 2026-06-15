/**
 * #974 Phase 1 — `DepartmentFacultyClient` (shared by the DEPARTMENT and DIVISION
 * rosters) passes each hit's `topMethods` to `PersonRow` as `methodChips`, so the
 * per-member method chips render. Asserts the wiring: a hit carrying `topMethods`
 * renders its family label; a hit with no `topMethods` renders no chip.
 *
 * Mirrors `person-row-method-chips.test.tsx`: decouple the headshot/popover import
 * graph so this stays a DB-free render unit.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));
vi.mock("@/components/scholar/person-popover", () => ({
  PersonPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { DepartmentFacultyClient } from "@/components/department/department-faculty-client";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

function hit(cwid: string, topMethods?: DepartmentFacultyHit["topMethods"]): DepartmentFacultyHit {
  return {
    cwid,
    preferredName: `Scholar ${cwid}`,
    slug: `scholar-${cwid}`,
    primaryTitle: "Professor",
    divisionName: null,
    departmentName: "Medicine",
    identityImageEndpoint: "",
    roleCategory: "full_time_faculty",
    overview: null,
    pubCount: 0,
    grantCount: 0,
    topMethods,
  };
}

function renderClient(faculty: DepartmentFacultyHit[]) {
  return render(
    <DepartmentFacultyClient
      faculty={faculty}
      total={faculty.length}
      roleCategoryCounts={{ "Full-time faculty": faculty.length }}
      page={1}
      pageSize={20}
      deptSlug="medicine"
      divisionSlug={null}
    />,
  );
}

describe("DepartmentFacultyClient method chips (#974)", () => {
  it("passes hit.topMethods through to PersonRow → renders the chip label", () => {
    renderClient([
      hit("abc1234", [
        {
          value: "sc::Deep learning",
          supercategory: "sc",
          familyLabel: "Deep learning",
          pmidCount: 12,
          exemplarTools: ["MONAI"],
        },
      ]),
    ]);

    expect(screen.getByText("Deep learning")).toBeTruthy();
  });

  it("renders no chip for a hit with no topMethods", () => {
    renderClient([hit("def5678", undefined)]);
    expect(screen.queryByText("Deep learning")).toBeNull();
  });
});
