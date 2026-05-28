/**
 * `components/edit/department-picker.tsx` — the in-memory department typeahead
 * (#540 Phase 7d). Filters the provided bounded list; selecting yields the full
 * {code,name}; the selected state shows a chip + clear.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { DepartmentPicker } from "@/components/edit/department-picker";

const DEPTS = [
  { code: "N1280", name: "Medicine" },
  { code: "N2000", name: "Surgery" },
  { code: "N3000", name: "Pediatrics" },
];

describe("DepartmentPicker", () => {
  it("filters by name and selects an option with its full {code,name}", () => {
    const onChange = vi.fn();
    render(<DepartmentPicker departments={DEPTS} value={null} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("department-input"), { target: { value: "surg" } });
    expect(screen.queryByTestId("department-option-N1280")).toBeNull();
    fireEvent.mouseDown(screen.getByTestId("department-option-N2000"));
    expect(onChange).toHaveBeenCalledWith({ code: "N2000", name: "Surgery" });
  });

  it("filters by code too", () => {
    render(<DepartmentPicker departments={DEPTS} value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("department-input"), { target: { value: "N3000" } });
    expect(screen.getByTestId("department-option-N3000")).toBeTruthy();
    expect(screen.queryByTestId("department-option-N1280")).toBeNull();
  });

  it("shows a chip + clear when a value is selected", () => {
    const onChange = vi.fn();
    render(
      <DepartmentPicker departments={DEPTS} value={{ code: "N1280", name: "Medicine" }} onChange={onChange} />,
    );
    expect(screen.getByText("Medicine")).toBeTruthy();
    fireEvent.click(screen.getByTestId("department-clear"));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("shows 'No matches' when nothing matches", () => {
    render(<DepartmentPicker departments={DEPTS} value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByTestId("department-input"), { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });
});
