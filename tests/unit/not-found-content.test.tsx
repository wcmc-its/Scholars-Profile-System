import { describe, expect, it } from "vitest";
import { render, within } from "@testing-library/react";
import { NotFoundContent } from "@/components/site/not-found-content";

describe("NotFoundContent browse links (#2245)", () => {
  it("labels /browse for what it holds (departments & centers), not an A–Z index", () => {
    const { container } = render(<NotFoundContent />);
    const nav = within(container).getByRole("navigation", { name: "Browse" });
    const link = within(nav).getByRole("link", { name: "Departments & centers" });
    expect(link.getAttribute("href")).toBe("/browse");
    expect(within(nav).queryByText(/A–Z/)).toBeNull();
  });
});
