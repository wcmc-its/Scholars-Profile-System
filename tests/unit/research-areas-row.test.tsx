/**
 * #709 — Research Areas chip row. Renders the matched areas as chips below the
 * count line; caps at 4 with a click-to-expand "+N more"; renders nothing when
 * no area matched.
 */
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResearchAreasRow, MethodPreview } from "@/components/search/research-areas-row";
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
    supercategory: null,
    familyLabel: null,
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

// #860 — Method-taxonomy "Methods and Tools" chip row (replaces the #824 callout).
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
    supercategory: entityType === "methodFamily" || entityType === "supercategory" ? "imaging" : null,
    familyLabel: entityType === "methodFamily" ? name : null,
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

describe("ResearchAreasRow — Methods and Tools chip row (#860)", () => {
  // The eyebrow / description / stats / "View the … page →" link now live in the
  // Radix HoverCard, which is portalled and only mounted on open — these tests
  // assert the always-rendered chip + link + label rather than the hover body.
  // The page link is covered by the chip href below.
  it("renders a matched method as a chip linking to its page, under the label", () => {
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
    expect(screen.getByText("Methods and Tools")).toBeTruthy();
    const chip = screen.getByText("Flow Cytometry").closest("a");
    expect(chip?.getAttribute("href")).toBe(
      "/methods/imaging-image-analysis/flow-cytometry-fam_0001",
    );
  });

  it("renders a supercategory match as a chip (eyebrow is hover-only now)", () => {
    render(
      <ResearchAreasRow
        result={methodResult([
          methodMatch("Genomics & Sequencing", "supercategory", "/methods/genomics-sequencing", 500, 0),
        ])}
      />,
    );
    const chip = screen.getByText("Genomics & Sequencing").closest("a");
    expect(chip?.getAttribute("href")).toBe("/methods/genomics-sequencing");
  });

  it("caps the methods row at 4 and '+N more' expands the rest inline", () => {
    render(
      <ResearchAreasRow
        result={methodResult([
          methodMatch("Flow Cytometry", "methodFamily", "/methods/a/flow-fam_1", 10, 5),
          methodMatch("Mass Cytometry", "methodFamily", "/methods/a/mass-fam_2", 8, 4),
          methodMatch("CyTOF", "methodFamily", "/methods/a/cytof-fam_3", 7, 3),
          methodMatch("FACS", "methodFamily", "/methods/a/facs-fam_4", 6, 2),
          methodMatch("Imaging Flow", "methodFamily", "/methods/a/imaging-fam_5", 5, 1),
        ])}
      />,
    );
    // 5th method is collapsed until expanded.
    expect(screen.getByText("Flow Cytometry")).toBeTruthy();
    expect(screen.queryByText("Imaging Flow")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 more method/ }));
    expect(screen.getByText("Imaging Flow")).toBeTruthy();
  });

  it("renders the methods row AND the topic chip row together", () => {
    render(
      <ResearchAreasRow
        result={methodResult(
          [methodMatch("Flow Cytometry", "methodFamily", "/methods/a/flow-fam_1", 10, 5)],
          [area("Immunology", 30)],
        )}
      />,
    );
    expect(screen.getByText("Research Areas")).toBeTruthy();
    expect(screen.getByText("Methods and Tools")).toBeTruthy();
    expect(screen.getByText("Immunology")).toBeTruthy();
    expect(screen.getByText("Flow Cytometry")).toBeTruthy();
  });

  it("renders nothing when neither areas nor methodMatches are present", () => {
    const { container } = render(<ResearchAreasRow result={methodResult([], [])} />);
    expect(container.textContent).toBe("");
  });
});

// #860 — MethodPreview is the hover-card body (eyebrow / description / stats /
// "View the … page →" link). At rest it lives in an un-mounted Radix portal, so
// it is unit-tested directly here rather than by driving the hover open — this
// restores the eyebrow / stat / pluralization / publicationCount-gate assertions
// dropped when the body moved into the portalled HoverCard.
describe("MethodPreview (#860 hover-card body)", () => {
  it("uses the 'Method family' eyebrow for a methodFamily, and renders description + stats + page link", () => {
    render(
      <MethodPreview
        match={methodMatch(
          "Flow Cytometry",
          "methodFamily",
          "/methods/imaging-image-analysis/flow-cytometry-fam_0001",
          248,
          3914,
        )}
      />,
    );
    expect(screen.getByText("Method family")).toBeTruthy();
    expect(screen.getByText("Flow Cytometry descriptor.")).toBeTruthy();
    // scholar · publication stat line (plural on both).
    expect(screen.getByText(/248 scholars · 3,914 publications/)).toBeTruthy();
    const link = screen.getByText(/View the Flow Cytometry page/).closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/methods/imaging-image-analysis/flow-cytometry-fam_0001",
    );
  });

  it("uses the 'Research methods' eyebrow for a supercategory", () => {
    render(
      <MethodPreview
        match={methodMatch("Genomics & Sequencing", "supercategory", "/methods/genomics-sequencing", 500, 12)}
      />,
    );
    expect(screen.getByText("Research methods")).toBeTruthy();
  });

  it("omits the publication count when publicationCount is 0", () => {
    render(
      <MethodPreview
        match={methodMatch("Genomics & Sequencing", "supercategory", "/methods/genomics-sequencing", 500, 0)}
      />,
    );
    expect(screen.getByText("500 scholars")).toBeTruthy();
    expect(screen.queryByText(/publication/)).toBeNull();
  });

  it("uses singular 'scholar' / 'publication' for counts of 1", () => {
    render(
      <MethodPreview
        match={methodMatch("CRISPR", "methodFamily", "/methods/genome-editing/crispr-fam_0002", 1, 1)}
      />,
    );
    expect(screen.getByText(/1 scholar · 1 publication$/)).toBeTruthy();
  });
});
