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

  it("collapsed by default — only the Abstract chevron button is visible", () => {
    const { container } = render(
      <AbstractDisclosure abstract="The mitochondrion is the powerhouse of the cell." />,
    );
    const btn = screen.getByRole("button", { name: /Abstract/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toContain("▼");
    // No paragraph rendered while collapsed.
    expect(container.querySelector("p")).toBeNull();
    // No Show more affordance while collapsed.
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("clicking the chevron reveals the abstract clamped to 3 lines with Show more", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" />);
    fireEvent.click(screen.getByRole("button", { name: /Abstract/ }));
    const btn = screen.getByRole("button", { name: /Abstract/ });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toContain("▲");
    const para = container.querySelector("p");
    expect(para?.className).toContain("line-clamp-3");
    const showMore = screen.getByRole("button", { name: "Show more" });
    expect(showMore.getAttribute("aria-expanded")).toBe("false");
  });

  it("clicking Show more removes the clamp and flips the label/aria", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" />);
    fireEvent.click(screen.getByRole("button", { name: /Abstract/ }));
    const showMore = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(showMore);
    expect(showMore.getAttribute("aria-expanded")).toBe("true");
    expect(showMore.textContent).toBe("Show less");
    const para = container.querySelector("p");
    expect(para?.className).not.toContain("line-clamp-");
  });

  it("collapsing the chevron hides the abstract paragraph and the Show more button", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" />);
    const chevron = screen.getByRole("button", { name: /Abstract/ });
    fireEvent.click(chevron);
    fireEvent.click(chevron);
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("renders fully with no chevron and no clamp when clampLines={false}", () => {
    const { container } = render(
      <AbstractDisclosure abstract="abc" clampLines={false} />,
    );
    expect(container.querySelectorAll("button").length).toBe(0);
    const para = container.querySelector("p");
    expect(para?.textContent).toBe("abc");
    expect(para?.className).not.toContain("line-clamp-");
  });

  it("respects custom clampLines (2) after expand", () => {
    const { container } = render(<AbstractDisclosure abstract="abc" clampLines={2} />);
    fireEvent.click(screen.getByRole("button", { name: /Abstract/ }));
    const para = container.querySelector("p");
    expect(para?.className).toContain("line-clamp-2");
  });
});
