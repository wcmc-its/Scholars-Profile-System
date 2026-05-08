import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("PersonRow", () => {
  it("formats FULL_TIME_FACULTY enum to 'Full-time faculty' label", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FULL_TIME_FACULTY" }} />);
    expect(screen.getByText("Full-time faculty")).toBeTruthy();
  });

  it("formats VOLUNTARY_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "VOLUNTARY_FACULTY" }} />);
    expect(screen.getByText("Voluntary faculty")).toBeTruthy();
  });

  it("formats ADJUNCT_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "ADJUNCT_FACULTY" }} />);
    expect(screen.getByText("Adjunct faculty")).toBeTruthy();
  });

  it("formats COURTESY_FACULTY enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "COURTESY_FACULTY" }} />);
    expect(screen.getByText("Courtesy faculty")).toBeTruthy();
  });

  it("formats FACULTY_EMERITUS enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FACULTY_EMERITUS" }} />);
    expect(screen.getByText("Faculty emeritus")).toBeTruthy();
  });

  it("formats INSTRUCTOR enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "INSTRUCTOR" }} />);
    expect(screen.getByText("Instructor")).toBeTruthy();
  });

  it("formats LECTURER enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "LECTURER" }} />);
    expect(screen.getByText("Lecturer")).toBeTruthy();
  });

  it("formats POSTDOC enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "POSTDOC" }} />);
    expect(screen.getByText("Postdoc")).toBeTruthy();
  });

  it("formats FELLOW enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "FELLOW" }} />);
    expect(screen.getByText("Fellow")).toBeTruthy();
  });

  it("formats RESEARCH_STAFF enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "RESEARCH_STAFF" }} />);
    expect(screen.getByText("Research staff")).toBeTruthy();
  });

  it("formats DOCTORAL_STUDENT enum", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "DOCTORAL_STUDENT" }} />);
    expect(screen.getByText("Doctoral student")).toBeTruthy();
  });

  it("omits stats column entirely when both pubs and grants are 0", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 0, grantCount: 0 }} />
    );
    expect(container.textContent).not.toContain("pub");
    expect(container.textContent).not.toContain("grant");
  });

  it("uses singular 'pub' when N=1, plural 'pubs' otherwise", () => {
    const { container: c1 } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 1, grantCount: 0 }} />
    );
    expect(c1.textContent).toContain("1 pub");
    expect(c1.textContent).not.toContain("pubs");

    const { container: c2 } = render(
      <PersonRow hit={{ ...baseHit, pubCount: 5, grantCount: 0 }} />
    );
    expect(c2.textContent).toContain("5 pubs");
  });

  it("renders department/division line with middle-dot when division present", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, divisionName: "Cardiology", departmentName: "Medicine" }} />
    );
    expect(container.textContent).toContain("Cardiology · Department of Medicine");
  });

  it("renders 'Department of {Name}' when no division", () => {
    const { container } = render(
      <PersonRow hit={{ ...baseHit, divisionName: null, departmentName: "Medicine" }} />
    );
    expect(container.textContent).toContain("Department of Medicine");
    expect(container.textContent).not.toContain("·");
  });

  it("component exports (RED: implementation pending Plan 08)", () => {
    expect(typeof PersonRow).toBe("function");
  });
});
