/**
 * #709 — Research Areas chip row. Renders the matched areas as chips below the
 * count line; caps at 4 with a click-to-expand "+N more"; renders nothing when
 * no area matched.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResearchAreasRow } from "@/components/search/research-areas-row";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

function area(name: string, n: number): TaxonomyMatch {
  return {
    entityType: "parentTopic",
    id: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    parentTopicId: null,
    parentTopicLabel: null,
    href: `/topics/${name.toLowerCase().replace(/\s+/g, "-")}`,
    scholarCount: n,
    publicationCount: n * 3,
    similarity: 1 / name.length,
    description: `${name} description.`,
    subtopicCount: 2,
  };
}

function matches(names: string[], totalMatched?: number): TaxonomyMatchResult {
  const areas = names.map((nm, i) => area(nm, 100 - i));
  return {
    state: "matches",
    primary: areas[0],
    secondary: areas.slice(1, 5),
    overflowCount: 0,
    query: "breast cancer",
    meshResolution: null,
    areas,
    totalMatched: totalMatched ?? names.length,
  };
}

describe("ResearchAreasRow (#709)", () => {
  it("renders the label, the top-4 chips, and a '+N more' control", () => {
    render(
      <ResearchAreasRow
        result={matches(["Breast Cancer", "Metastatic", "Triple-Negative", "Biomarkers", "Genomics", "Imaging"])}
      />,
    );
    expect(screen.getByText("Research Areas")).toBeTruthy();
    expect(screen.getByText("Breast Cancer")).toBeTruthy();
    expect(screen.getByText("Biomarkers")).toBeTruthy();
    // 5th/6th are collapsed
    expect(screen.queryByText("Genomics")).toBeNull();
    expect(screen.getByRole("button", { name: /2 more/ })).toBeTruthy(); // 6 − 4
  });

  it("chips link to the topic page", () => {
    render(<ResearchAreasRow result={matches(["Breast Cancer", "Metastatic"])} />);
    const chip = screen.getByText("Breast Cancer").closest("a");
    expect(chip?.getAttribute("href")).toBe("/topics/breast-cancer");
  });

  it("'+N more' expands the rest inline", () => {
    render(
      <ResearchAreasRow
        result={matches(["Breast Cancer", "Metastatic", "Triple-Negative", "Biomarkers", "Genomics"])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /1 more/ }));
    expect(screen.getByText("Genomics")).toBeTruthy();
  });

  it("renders nothing when no area matched (RA-12)", () => {
    const { container } = render(
      <ResearchAreasRow result={{ state: "none", meshResolution: null }} />,
    );
    expect(container.textContent).toBe("");
  });
});
