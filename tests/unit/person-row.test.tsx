import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PersonRow } from "@/components/department/person-row";

describe("PersonRow", () => {
  it.todo("renders all 11 role tag values: Full-time faculty, Voluntary faculty, Adjunct faculty, Courtesy faculty, Faculty emeritus, Instructor, Lecturer, Postdoc, Fellow, Research staff, Doctoral student");
  it.todo("omits stats column entirely when both pubs and grants are 0");
  it.todo("uses singular 'pub' when N=1, plural 'pubs' otherwise");
  it.todo("renders department/division line with middle-dot when division present");
  it.todo("renders 'Department of {Name}' when no division");
  it("component exports (RED: implementation pending Plan 08)", () => {
    expect(typeof PersonRow).toBe("function");
  });
});
