/**
 * #824 follow-up — PeopleResultCard renders the match-aware "why" line:
 *   - { kind:"method" } ⇒ a "Method" badge, bold family label, muted " · " tools;
 *   - { kind:"topic" }  ⇒ a "Topic" badge + bold label;
 *   - humanizedAreas    ⇒ comma-separated labels (no under_scores), matched bold;
 *   - the legacy { icon, text } reason still renders (regression guard);
 *   - priority: method/topic reason wins over a bio highlight + humanizedAreas.
 * Badges are <span>s (no nested interactive element inside the row <Link>).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/scholar/headshot-avatar", () => ({
  HeadshotAvatar: () => <div data-testid="avatar" />,
}));

import { PeopleResultCard } from "@/components/search/people-result-card";
import type { PeopleHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PeopleHit>): PeopleHit {
  return {
    cwid: "abc1234",
    slug: "jane-doe",
    preferredName: "Jane Doe",
    primaryTitle: "Professor of Medicine",
    primaryDepartment: "Medicine",
    deptName: "Medicine",
    divisionName: null,
    roleCategory: "full_time_faculty",
    pubCount: 100,
    grantCount: 5,
    hasActiveGrants: true,
    identityImageEndpoint: "https://example.com/abc1234.png",
    ...overrides,
  };
}

const props = {
  position: 0,
  q: "single cell rna sequencing",
  total: 1,
  filters: { deptDiv: [], personType: [], activity: [] },
};

describe("PeopleResultCard — #824 match-aware snippet", () => {
  it("renders the method badge + bold family, with NO exemplar-tool trail", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: {
            kind: "method",
            family: "Single-cell RNA sequencing",
            tools: ["scRNA-seq", "single-nuclei", "10x"],
          },
        })}
      />,
    );
    expect(screen.getByText("Method")).toBeTruthy();
    const family = screen.getByText("Single-cell RNA sequencing");
    expect(family.tagName).toBe("STRONG");
    // The muted dot-separated tool trail was dropped from the method row.
    expect(screen.queryByText("scRNA-seq")).toBeNull();
    expect(screen.queryByText("single-nuclei")).toBeNull();
    expect(screen.queryByText("10x")).toBeNull();
  });

  it("renders the method badge with no tools (empty exemplar list)", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { kind: "method", family: "Mass spectrometry", tools: [] },
        })}
      />,
    );
    expect(screen.getByText("Method")).toBeTruthy();
    expect(screen.getByText("Mass spectrometry").tagName).toBe("STRONG");
  });

  it("renders the topic badge + bold label", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { kind: "topic", label: "Single-cell & spatial biology" },
        })}
      />,
    );
    expect(screen.getByText("Research area")).toBeTruthy();
    expect(screen.getByText("Single-cell & spatial biology").tagName).toBe("STRONG");
  });

  it("renders humanized areas without underscores, bolding the matched area", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          humanizedAreas: {
            labels: [
              "Single-cell & spatial biology",
              "Metabolic & endocrine disease",
              "Lung cancer",
            ],
            matchedIndex: 0,
          },
        })}
      />,
    );
    expect(screen.getByText("Single-cell & spatial biology").tagName).toBe("STRONG");
    expect(screen.getByText(/Metabolic & endocrine disease/)).toBeTruthy();
    // No raw slug text leaks into the DOM.
    expect(screen.queryByText(/single_cell_spatial_biology/)).toBeNull();
  });

  it("prioritizes the method reason over a bio highlight + humanizedAreas", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { kind: "method", family: "Flow cytometry", tools: ["FACS"] },
          highlight: ["A bio sentence about <mark>cells</mark>"],
          humanizedAreas: { labels: ["Immunology"], matchedIndex: -1 },
        })}
      />,
    );
    expect(screen.getByText("Method")).toBeTruthy();
    expect(screen.getByText("Flow cytometry").tagName).toBe("STRONG");
    // The lower-priority surfaces do not render.
    expect(screen.queryByText(/A bio sentence about/)).toBeNull();
    expect(screen.queryByText("Immunology")).toBeNull();
  });

  it("still renders the legacy { icon, text } reason (regression guard)", () => {
    render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { icon: "publications", text: "14 of 100 publications tagged HIV" },
        })}
      />,
    );
    expect(screen.getByText(/14 of 100 publications tagged HIV/)).toBeTruthy();
    // No method/research-area badge for the legacy variant.
    expect(screen.queryByText("Method")).toBeNull();
    expect(screen.queryByText("Research area")).toBeNull();
  });

  it("badges are spans, not nested interactive elements, inside the row Link", () => {
    const { container } = render(
      <PeopleResultCard
        {...props}
        hit={makeHit({
          matchReason: { kind: "method", family: "X", tools: ["t"] },
        })}
      />,
    );
    // Exactly one anchor (the row link); no nested <a>/<button> from the badge.
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText("Method").tagName).toBe("SPAN");
  });
});
