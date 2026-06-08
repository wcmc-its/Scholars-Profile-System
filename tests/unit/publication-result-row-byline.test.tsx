/**
 * #718 — PublicationResultRow author fallback: chips when there's a displayable
 * WCM author, the unstructured byline when there isn't (and one exists), nothing
 * when both are empty (suppressed/dark).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Isolate the row's author branch: stub the modal hook (no provider needed) and
// the heavy chip/meta children so the test asserts only the chips-vs-byline pick.
vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: ({ authors }: { authors: unknown[] }) => (
    <div data-testid="chip-row">{authors.length} chips</div>
  ),
}));
vi.mock("@/components/publication/publication-meta", () => ({
  PublicationMeta: () => <div data-testid="meta" />,
}));

import { PublicationResultRow } from "@/components/search/publication-result-row";
import type { PublicationHit } from "@/lib/api/search";

function makeHit(overrides: Partial<PublicationHit>): PublicationHit {
  return {
    pmid: "39406234",
    title: "Analysis of single-cell CRISPR perturbations",
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
    ...overrides,
  };
}

const oneChipAuthor = {
  name: "Ada First",
  cwid: "aaa1111",
  slug: "ada-first",
  identityImageEndpoint: "https://example.com/aaa1111.png",
  isFirst: true,
  isLast: false,
  roleCategory: "full_time_faculty" as string | null,
};

describe("PublicationResultRow — #718 author fallback", () => {
  it("renders the unstructured byline when there is no displayable WCM chip", () => {
    render(
      <PublicationResultRow
        hit={makeHit({ wcmAuthors: [], authorsFallback: "Mejia J, Smith A, Doe B" })}
      />,
    );
    expect(screen.getByText("Mejia J, Smith A, Doe B")).toBeTruthy();
    expect(screen.queryByTestId("chip-row")).toBeNull();
  });

  it("renders nothing in the author region when both chips and byline are empty (suppressed/dark)", () => {
    render(<PublicationResultRow hit={makeHit({ wcmAuthors: [], authorsFallback: null })} />);
    expect(screen.queryByTestId("chip-row")).toBeNull();
    expect(screen.queryByText(/Mejia|Smith|Doe/)).toBeNull();
  });

  it("renders chips (not the byline) when there is a displayable WCM author", () => {
    render(
      <PublicationResultRow
        hit={makeHit({
          wcmAuthors: [oneChipAuthor],
          // even if a byline were hydrated, chips win — but it's null in practice
          authorsFallback: null,
        })}
      />,
    );
    expect(screen.getByTestId("chip-row").textContent).toBe("1 chips");
  });
});
