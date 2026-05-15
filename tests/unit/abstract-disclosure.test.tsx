import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AbstractDisclosure } from "@/components/publication/abstract-disclosure";

describe("AbstractDisclosure", () => {
  it("renders nothing when abstract is null", () => {
    const { container } = render(<AbstractDisclosure abstract={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when abstract is an empty string", () => {
    const { container } = render(<AbstractDisclosure abstract="" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the abstract text when present", () => {
    render(<AbstractDisclosure abstract="The mitochondrion is the powerhouse of the cell." />);
    expect(
      screen.getByText("The mitochondrion is the powerhouse of the cell."),
    ).toBeTruthy();
  });

  it("clamps by default with line-clamp-3 and shows the Show more button", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" />);
    const para = container.querySelector("p");
    expect(para?.className).toContain("line-clamp-3");
    const btn = screen.getByRole("button", { name: "Show more" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles expanded state and flips aria-expanded + label on click", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" />);
    const btn = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toBe("Show less");
    const para = container.querySelector("p");
    expect(para?.className).not.toContain("line-clamp-");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toBe("Show more");
  });

  it("renders fully with no button when clampLines={false}", () => {
    const { container } = render(
      <AbstractDisclosure abstract="abc" clampLines={false} />,
    );
    expect(container.querySelector("button")).toBeNull();
    const para = container.querySelector("p");
    expect(para?.className).not.toContain("line-clamp-");
  });

  it("respects custom clampLines (2)", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" clampLines={2} />);
    const para = container.querySelector("p");
    expect(para?.className).toContain("line-clamp-2");
  });
});
