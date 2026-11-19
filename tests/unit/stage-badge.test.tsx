import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageBadge } from "@/components/publication/stage-badge";

describe("StageBadge", () => {
  it("renders the code then the stage name, as an outline badge", () => {
    render(<StageBadge stage="T3-4" />);
    const badge = screen.getByTestId("pub-row-stage");
    expect(badge.getAttribute("data-slot")).toBe("badge");
    expect(badge.textContent).toBe("T3\u20134 Practice and population health");
  });
});
