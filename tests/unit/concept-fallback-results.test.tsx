/**
 * Issue #298 §4/§5 — render contract for the broad-text co-render block:
 * the divider band copy, the §5 cap on the inline preview, the "View all N"
 * link target (`?mesh=off`, filters preserved), and the empty-input no-render.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Stub the row's heavy client subtree (modal hook + chip/meta children) so the
// test asserts the block's own structure, not PublicationResultRow internals.
vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: () => <div data-testid="chip-row" />,
}));
vi.mock("@/components/publication/publication-meta", () => ({
  PublicationMeta: () => <div data-testid="meta" />,
}));

import { ConceptFallbackResults } from "@/components/search/concept-fallback-results";
import type { PublicationHit } from "@/lib/api/search";

function makeHit(pmid: string): PublicationHit {
  return {
    pmid,
    title: `Paper ${pmid}`,
    titleHighlight: null,
    journal: "Nature",
    year: 2024,
    publicationType: "Academic Article",
    citationCount: 0,
    doi: null,
    pmcid: null,
    pubmedUrl: null,
    wcmAuthors: [],
    authorsFallback: null,
    impactScore: null,
    conceptImpactScore: null,
    impactJustification: null,
    abstract: null,
  };
}

const VIEW_ALL = "/search?q=health+economics&mesh=off";

describe("ConceptFallbackResults (§4/§5)", () => {
  it("renders the divider band copy with the un-capped total", () => {
    render(
      <ConceptFallbackResults
        query="health economics"
        hits={[makeHit("1"), makeHit("2")]}
        total={124}
        viewAllHref={VIEW_ALL}
      />,
    );
    // §4.3 divider copy — identical across triggers.
    expect(
      screen.getByText(/More results mentioning .*health economics.* — 124 publications/),
    ).toBeTruthy();
  });

  it("caps the inline preview at the default cap of 10 even when handed more", () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeHit(String(i)));
    const { container } = render(
      <ConceptFallbackResults query="x" hits={hits} total={400} viewAllHref={VIEW_ALL} />,
    );
    // One <li> per previewed row; the cap clamps 25 → 10.
    expect(container.querySelectorAll("li").length).toBe(10);
  });

  it("honors an explicit cap prop", () => {
    const hits = Array.from({ length: 8 }, (_, i) => makeHit(String(i)));
    const { container } = render(
      <ConceptFallbackResults query="x" hits={hits} total={8} viewAllHref={VIEW_ALL} cap={3} />,
    );
    expect(container.querySelectorAll("li").length).toBe(3);
  });

  it("'View all N' link targets the ?mesh=off page (filters preserved by the caller's href)", () => {
    render(
      <ConceptFallbackResults
        query="x"
        hits={[makeHit("1")]}
        total={47}
        viewAllHref={VIEW_ALL}
      />,
    );
    const link = screen.getByRole("link", { name: /View all 47 broad results/ });
    expect(link.getAttribute("href")).toBe(VIEW_ALL);
  });

  it("announces the broader-results fallback to screen readers (#298 §10)", () => {
    render(
      <ConceptFallbackResults
        query="health economics"
        hits={[makeHit("1")]}
        total={124}
        viewAllHref={VIEW_ALL}
      />,
    );
    const status = screen.getByTestId("concept-fallback-announcement");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.className).toContain("sr-only");
    expect(status.textContent).toBe(
      "Showing 124 broader results mentioning health economics below.",
    );
  });

  it("singularizes the SR announcement for a single broad result", () => {
    render(
      <ConceptFallbackResults query="x" hits={[makeHit("1")]} total={1} viewAllHref={VIEW_ALL} />,
    );
    expect(screen.getByTestId("concept-fallback-announcement").textContent).toBe(
      "Showing 1 broader result mentioning x below.",
    );
  });

  it("renders nothing when there are no hits to preview", () => {
    const { container } = render(
      <ConceptFallbackResults query="x" hits={[]} total={0} viewAllHref={VIEW_ALL} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("singularizes the divider + link copy for a single broad result", () => {
    render(
      <ConceptFallbackResults
        query="x"
        hits={[makeHit("1")]}
        total={1}
        viewAllHref={VIEW_ALL}
      />,
    );
    expect(screen.getByText(/— 1 publication$/)).toBeTruthy();
    // Accessible name keeps the trailing arrow; match "result" not pluralized.
    expect(
      screen.getByRole("link", { name: /View all 1 broad result(?!s)/ }),
    ).toBeTruthy();
  });
});
