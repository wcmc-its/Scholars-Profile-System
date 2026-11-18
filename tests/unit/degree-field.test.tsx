import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { DegreeField } from "@/components/edit/degree-field";

const box = (deg: string) =>
  screen.getByTestId(`degree-option-${deg}`).querySelector("input") as HTMLInputElement;

describe("DegreeField", () => {
  it("pre-ticks the degrees the directory string names, keeping MB,BS whole", () => {
    render(
      <DegreeField
        cwid="s01"
        options={["MB,BS", "PhD", "MPH"]}
        selected={null}
        directory="MB,BS, PhD"
        current="MB,BS, PhD"
      />,
    );
    expect(box("MB,BS").checked).toBe(true);
    expect(box("PhD").checked).toBe(true);
    expect(box("MPH").checked).toBe(false);
  });

  it("pre-ticks the saved pick when there is one", () => {
    render(
      <DegreeField
        cwid="s01"
        options={["MD", "PhD", "MPH"]}
        selected={["MD", "PhD", "MPH"]}
        directory="PhD, MD"
        current="MD, PhD, MPH"
      />,
    );
    expect(box("MPH").checked).toBe(true);
    expect(screen.getByTestId("degree-preview").textContent).toContain(
      "Directory default: PhD, MD",
    );
  });

  it("renders the plain value when ASMS offers nothing to choose", () => {
    render(<DegreeField cwid="s01" options={[]} selected={null} directory="MD" current="MD" />);
    expect(screen.getByText("MD")).toBeTruthy();
  });
});
