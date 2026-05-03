import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CuratedTag } from "@/components/topic/curated-tag";

describe("CuratedTag", () => {
  it("renders 'Curated' label text with publication_centric surface", () => {
    render(<CuratedTag surface="publication_centric" />);
    expect(screen.getByText("Curated")).toBeTruthy();
  });

  it("renders 'Curated' label text with scholar_centric surface", () => {
    render(<CuratedTag surface="scholar_centric" />);
    expect(screen.getByText("Curated")).toBeTruthy();
  });

  it("renders Info icon with aria-label='Learn more about Curated ranking'", () => {
    const { container } = render(<CuratedTag surface="publication_centric" />);
    const icon = container.querySelector('[aria-label="Learn more about Curated ranking"]');
    expect(icon).not.toBeNull();
  });

  it("applies slate-light background color class to the tag span", () => {
    const { container } = render(<CuratedTag surface="publication_centric" />);
    // The tag span should contain bg-[#e8eff5] per design spec §6.4
    const tag = container.querySelector("span.inline-flex");
    expect(tag).not.toBeNull();
    expect(tag?.className).toContain("bg-[#e8eff5]");
  });

  it("component exports (RED: implementation pending Plan 07)", () => {
    expect(typeof CuratedTag).toBe("function");
  });
});
