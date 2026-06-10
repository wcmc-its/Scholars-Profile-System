/**
 * Render tests for the home "Browse by research method" section (spec §5/§11).
 *
 * Pure presentational component fed a fixture — no DB/flag mocking. The
 * MethodBeaconLink it imports is a client component using next/link +
 * navigator.sendBeacon; under jsdom sendBeacon is undefined so the SSR guard
 * returns early (clicks inert) and next/link renders a plain <a> (mirrors
 * methods-hub-grid.test.tsx, which renders next/link without mocking).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrowseByMethodSection } from "@/components/home/browse-by-method-section";
import type { HomeMethodCategories } from "@/lib/api/home";

const data: HomeMethodCategories = {
  categories: [
    {
      slug: "animal-cell-models",
      label: "Animal & Cell Models",
      familyCount: 47,
      representativeFamilies: ["Mouse models", "Organoids"],
    },
    {
      slug: "genomics-sequencing",
      label: "Genomics & Sequencing",
      familyCount: 47,
      representativeFamilies: [
        "Single-cell RNA sequencing",
        "Spatial transcriptomics",
        "WGS",
      ],
    },
    {
      slug: "molecular-biochemical-reagents",
      label: "Molecular & Biochemical Reagents",
      familyCount: 110,
      representativeFamilies: [],
    },
  ],
  categoryCount: 3,
  totalFamilyCount: 204,
};

describe("BrowseByMethodSection", () => {
  it("renders all categories", () => {
    render(<BrowseByMethodSection data={data} />);
    expect(screen.getByText("Animal & Cell Models")).toBeTruthy();
    expect(screen.getByText("Genomics & Sequencing")).toBeTruthy();
    expect(screen.getByText("Molecular & Biochemical Reagents")).toBeTruthy();
  });

  it("renders the category cards in the supplied (alphabetical) DOM order", () => {
    render(<BrowseByMethodSection data={data} />);
    const cardLabels = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label"))
      .filter((l): l is string => l !== null && l.includes("method families"));
    expect(cardLabels).toEqual([
      "Animal & Cell Models, 47 method families",
      "Genomics & Sequencing, 47 method families",
      "Molecular & Biochemical Reagents, 110 method families",
    ]);
  });

  it("links each category card to /methods/{slug}", () => {
    render(<BrowseByMethodSection data={data} />);
    const card = screen.getByText("Genomics & Sequencing").closest("a");
    expect(card?.getAttribute("href")).toBe("/methods/genomics-sequencing");
  });

  it("shows the live family count on each card", () => {
    render(<BrowseByMethodSection data={data} />);
    // 47 appears twice (two categories); 110 once.
    expect(screen.getAllByText("47").length).toBe(2);
    expect(screen.getByText("110")).toBeTruthy();
  });

  it("renders the representative-families scent line when present", () => {
    render(<BrowseByMethodSection data={data} />);
    expect(
      screen.getByText(
        "Single-cell RNA sequencing · Spatial transcriptomics · WGS",
      ),
    ).toBeTruthy();
  });

  it("tolerates an empty scent line (no scent text for a category with none)", () => {
    render(<BrowseByMethodSection data={data} />);
    const card = screen
      .getByText("Molecular & Biochemical Reagents")
      .closest("a")!;
    // The card text is only the label + count — no separator dot for a scent.
    expect(card.textContent).toBe("Molecular & Biochemical Reagents110");
    expect(card.textContent).not.toContain("·");
  });

  it("gives each card an accessible name combining label + family count", () => {
    render(<BrowseByMethodSection data={data} />);
    expect(
      screen.getByRole("link", {
        name: "Genomics & Sequencing, 47 method families",
      }),
    ).toBeTruthy();
  });

  it("renders the footer link to the full /methods directory", () => {
    render(<BrowseByMethodSection data={data} />);
    const footer = screen
      .getByText(/Explore all 204 method families/)
      .closest("a");
    expect(footer?.getAttribute("href")).toBe("/methods");
  });

  it("shows the live category count in the subhead", () => {
    render(<BrowseByMethodSection data={data} />);
    expect(screen.getByText(/3 categories/)).toBeTruthy();
  });

  it("renders nothing for an empty category list", () => {
    render(
      <BrowseByMethodSection
        data={{ categories: [], categoryCount: 0, totalFamilyCount: 0 }}
      />,
    );
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
