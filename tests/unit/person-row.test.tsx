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
  pubCount: 0,
  grantCount: 0,
};

describe("PersonRow", () => {
  it("renders all 11 role tag values: Full-time faculty", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Full-time faculty" }} />);
    expect(screen.getByText("Full-time faculty")).toBeTruthy();
  });

  it("renders Voluntary faculty role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Voluntary faculty" }} />);
    expect(screen.getByText("Voluntary faculty")).toBeTruthy();
  });

  it("renders Adjunct faculty role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Adjunct faculty" }} />);
    expect(screen.getByText("Adjunct faculty")).toBeTruthy();
  });

  it("renders Courtesy faculty role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Courtesy faculty" }} />);
    expect(screen.getByText("Courtesy faculty")).toBeTruthy();
  });

  it("renders Faculty emeritus role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Faculty emeritus" }} />);
    expect(screen.getByText("Faculty emeritus")).toBeTruthy();
  });

  it("renders Instructor role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Instructor" }} />);
    expect(screen.getByText("Instructor")).toBeTruthy();
  });

  it("renders Lecturer role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Lecturer" }} />);
    expect(screen.getByText("Lecturer")).toBeTruthy();
  });

  it("renders Postdoc role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Postdoc" }} />);
    expect(screen.getByText("Postdoc")).toBeTruthy();
  });

  it("renders Fellow role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Fellow" }} />);
    expect(screen.getByText("Fellow")).toBeTruthy();
  });

  it("renders Research staff role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Research staff" }} />);
    expect(screen.getByText("Research staff")).toBeTruthy();
  });

  it("renders Doctoral student role tag", () => {
    render(<PersonRow hit={{ ...baseHit, roleCategory: "Doctoral student" }} />);
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
