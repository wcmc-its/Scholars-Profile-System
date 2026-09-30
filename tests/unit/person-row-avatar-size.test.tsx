/**
 * #2531 — roster-row headshots shrink to 40px (`size="roster"`, `h-10 w-10`).
 * Scoped to `PersonRow` (the shared department/division/center roster row);
 * every other `HeadshotAvatar` call site keeps `size="md"` (48px).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PersonRow } from "@/components/department/person-row";
import type { DepartmentFacultyHit } from "@/lib/api/departments";

const baseHit: DepartmentFacultyHit = {
  cwid: "test123",
  preferredName: "Jane Smith",
  slug: "jane-smith",
  primaryTitle: "Associate Professor",
  divisionName: null,
  departmentName: "Medicine",
  identityImageEndpoint: "",
  roleCategory: null,
  overview: null,
  pubCount: 0,
  grantCount: 0,
};

describe("PersonRow avatar size (#2531)", () => {
  it("renders the roster-size (40px) headshot, not the 48px md size", () => {
    const { container } = render(<PersonRow hit={baseHit} />);
    const avatar = container.querySelector("[data-headshot-state]");
    expect(avatar).not.toBeNull();
    expect(avatar!.className).toContain("h-10");
    expect(avatar!.className).toContain("w-10");
  });
});
