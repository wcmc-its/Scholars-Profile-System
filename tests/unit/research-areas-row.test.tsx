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
    methodMatches: [],
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

// #824 PR-2 — Method-taxonomy callout card.
function methodMatch(
  name: string,
  entityType: TaxonomyMatch["entityType"],
  href: string,
  scholarCount: number,
  publicationCount: number,
): TaxonomyMatch {
  return {
    entityType,
    id: `${entityType}:${name}`,
    name,
    parentTopicId: null,
    parentTopicLabel: null,
    href,
    scholarCount,
    publicationCount,
    similarity: 0.9,
    description: `${name} descriptor.`,
    subtopicCount: 0,
  };
}

function methodResult(methodMatches: TaxonomyMatch[], areas: TaxonomyMatch[] = []): TaxonomyMatchResult {
  return {
    state: "matches",
    primary: (areas[0] ?? methodMatches[0])!,
    secondary: [],
    overflowCount: 0,
    query: "flow cytometry",
    meshResolution: null,
    areas,
    totalMatched: areas.length,
    methodMatches,
  };
}

describe("ResearchAreasRow — Method callout (#824)", () => {
  it("renders the method family card: name, Method badge, descriptor, stats, link", () => {
    render(
      <ResearchAreasRow
        result={methodResult([
          methodMatch(
            "Flow Cytometry",
            "methodFamily",
            "/methods/imaging-image-analysis/flow-cytometry-fam_0001",
            248,
            3914,
          ),
        ])}
      />,
    );
    expect(screen.getByText("Method & tool family")).toBeTruthy();
    expect(screen.getByText("Flow Cytometry")).toBeTruthy();
    expect(screen.getByText("Method")).toBeTruthy(); // the rust badge
    expect(screen.getByText("Flow Cytometry descriptor.")).toBeTruthy();
    expect(screen.getByText("248")).toBeTruthy();
    expect(screen.getByText("3,914")).toBeTruthy();
    const link = screen.getByText(/View the Flow Cytometry page/).closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/methods/imaging-image-analysis/flow-cytometry-fam_0001",
    );
  });

  it("uses the 'Research methods' eyebrow for a supercategory match", () => {
    render(
      <ResearchAreasRow
        result={methodResult([
          methodMatch("Genomics & Sequencing", "supercategory", "/methods/genomics-sequencing", 500, 0),
        ])}
      />,
    );
    expect(screen.getByText("Research methods")).toBeTruthy();
    // publicationCount 0 → the publications stat is omitted.
    expect(screen.queryByText("publications")).toBeNull();
  });

  it("discloses sibling method matches behind a '+N related methods' toggle", () => {
    render(
      <ResearchAreasRow
        result={methodResult([
          methodMatch("Flow Cytometry", "methodFamily", "/methods/a/flow-fam_1", 10, 5),
          methodMatch("Mass Cytometry", "methodFamily", "/methods/a/mass-fam_2", 8, 4),
        ])}
      />,
    );
    expect(screen.getByText("Flow Cytometry")).toBeTruthy();
    expect(screen.queryByText("Mass Cytometry")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 related method/ }));
    expect(screen.getByText("Mass Cytometry")).toBeTruthy();
  });

  it("renders the method card AND the topic chip row together", () => {
    render(
      <ResearchAreasRow
        result={methodResult(
          [methodMatch("Flow Cytometry", "methodFamily", "/methods/a/flow-fam_1", 10, 5)],
          [area("Immunology", 30)],
        )}
      />,
    );
    expect(screen.getByText("Method & tool family")).toBeTruthy();
    expect(screen.getByText("Research Areas")).toBeTruthy();
    expect(screen.getByText("Immunology")).toBeTruthy();
  });

  it("renders nothing when neither areas nor methodMatches are present", () => {
    const { container } = render(<ResearchAreasRow result={methodResult([], [])} />);
    expect(container.textContent).toBe("");
  });
});
