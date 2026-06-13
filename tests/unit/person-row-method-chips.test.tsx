/**
 * #962 — `PersonRow` method-chip rendering (center roster only). The chips ride a
 * separate `methodChips` prop (not `hit`, which is the shared `DepartmentFacultyHit`)
 * so the dept/division/flat-roster paths stay unaffected. Asserts: labels render
 * with the exemplarTools tooltip; nothing renders when the prop is empty/omitted.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Decouple from the popover / headshot import graph (DB-free unit).
vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));
vi.mock("@/components/scholar/person-popover", () => ({
  PersonPopover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PersonRow } from "@/components/department/person-row";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

const baseHit: DepartmentFacultyHit = {
  cwid: "abc1234",
  preferredName: "Ada Lovelace",
  slug: "ada-lovelace",
  primaryTitle: "Professor",
  divisionName: null,
  departmentName: "Medicine",
  identityImageEndpoint: "",
  roleCategory: "full_time_faculty",
  overview: null,
  pubCount: 0,
  grantCount: 0,
};

describe("PersonRow method chips (#962)", () => {
  it("renders the family labels with exemplarTools as the title tooltip", () => {
    render(
      <PersonRow
        hit={baseHit}
        methodChips={[
          { value: "sc::Deep learning", familyLabel: "Deep learning", exemplarTools: ["MONAI", "CheXpert"] },
          { value: "sc::MRI", familyLabel: "MRI", exemplarTools: [] },
        ]}
      />,
    );

    const dl = screen.getByText("Deep learning");
    expect(dl).toBeTruthy();
    expect(dl.getAttribute("title")).toBe("MONAI, CheXpert");

    const mri = screen.getByText("MRI");
    expect(mri).toBeTruthy();
    expect(mri.getAttribute("title")).toBeNull(); // no exemplars → no tooltip
  });

  it("renders no chips when methodChips is empty", () => {
    render(<PersonRow hit={baseHit} methodChips={[]} />);
    expect(screen.queryByText("Deep learning")).toBeNull();
  });

  it("renders no chips when methodChips is omitted", () => {
    render(<PersonRow hit={baseHit} />);
    expect(screen.queryByText("Deep learning")).toBeNull();
  });
});
