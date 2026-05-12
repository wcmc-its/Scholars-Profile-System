import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CuratedTag } from "@/components/topic/curated-tag";

// Post-#176 refactor: CuratedTag no longer renders a "Curated" pill — it
// wraps a SectionInfoButton (small (i) trigger that opens a popover
// linking to the methodology page). These tests verify the visible
// trigger surface for both supported surfaces.
describe("CuratedTag", () => {
  it("renders an info button for the publication_centric surface", () => {
    render(<CuratedTag surface="publication_centric" />);
    expect(
      screen.getByRole("button", { name: "About Curated ranking" }),
    ).toBeTruthy();
  });

  it("renders an info button for the scholar_centric surface", () => {
    render(<CuratedTag surface="scholar_centric" />);
    expect(
      screen.getByRole("button", { name: "About Curated ranking" }),
    ).toBeTruthy();
  });

  it("renders an Info icon inside the trigger", () => {
    const { container } = render(<CuratedTag surface="publication_centric" />);
    const button = container.querySelector(
      'button[aria-label="About Curated ranking"]',
    );
    expect(button).not.toBeNull();
    // The lucide Info icon renders as an inline SVG marked aria-hidden.
    expect(button?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("trigger is a type='button' so it never accidentally submits a form", () => {
    const { container } = render(<CuratedTag surface="publication_centric" />);
    const button = container.querySelector(
      'button[aria-label="About Curated ranking"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.type).toBe("button");
  });

  it("component exports a function", () => {
    expect(typeof CuratedTag).toBe("function");
  });
});
