import { describe, it, expect } from "vitest";
import { getDepartment, getDepartmentFaculty } from "@/lib/api/departments";

describe("getDepartment", () => {
  it.todo("returns department with chairCwid populated when chair appointment exists");
  it.todo("returns department with chairCwid null when no Chairman appointment");
  it.todo("includes top research areas (top 8-10 parent topics by pub count)");
  it.todo("returns null for unknown department slug");
  it("export exists (RED: implementation pending Plan 06)", () => {
    expect(typeof getDepartment).toBe("function");
  });
});

describe("getDepartmentFaculty", () => {
  it.todo("filters faculty by deptCode");
  it.todo("optionally filters by divCode when provided");
  it.todo("paginates 20 per page");
  it.todo("orders chief-of-division first when divCode provided, then by pub count desc");
  it("export exists (RED: implementation pending Plan 06)", () => {
    expect(typeof getDepartmentFaculty).toBe("function");
  });
});
