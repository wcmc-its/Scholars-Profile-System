/**
 * OpenAlex-lane publications (conference abstracts, preprints) carry a type
 * label on the profile row; every other publicationType renders none.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/publication/publication-modal", () => ({
  usePublicationModal: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/publication/author-chip-row", () => ({
  AuthorChipRow: () => null,
}));

import { PublicationRow, publicationTypeLabel } from "@/components/profile/publication-row";
import type { ProfileRowPublication } from "@/lib/profile/client-publication";

function makePub(overrides: Partial<ProfileRowPublication>): ProfileRowPublication {
  return {
    pmid: "OPENALEX:W4401234567",
    title: "A conference abstract",
    journal: "Journal of Thoracic Oncology",
    year: 2026,
    publicationType: "Academic Article",
    citationCount: 0,
    doi: null,
    pmcid: null,
    ecommonsLink: null,
    authorship: { isFirst: false, isLast: false },
    hasAbstract: false,
    wcmAuthors: [],
    ...overrides,
  };
}

describe("publicationTypeLabel", () => {
  it("labels the two OpenAlex types and nothing else", () => {
    expect(publicationTypeLabel("conference-abstract")).toBe("Conference abstract");
    expect(publicationTypeLabel("preprint")).toBe("Preprint");
    expect(publicationTypeLabel("Academic Article")).toBeNull();
    expect(publicationTypeLabel("Review")).toBeNull();
    expect(publicationTypeLabel(null)).toBeNull();
    expect(publicationTypeLabel(undefined)).toBeNull();
  });
});

describe("PublicationRow type label", () => {
  it.each([
    ["conference-abstract", "Conference abstract"],
    ["preprint", "Preprint"],
  ])("renders %s as a %s badge", (type, label) => {
    render(<PublicationRow pub={makePub({ publicationType: type })} />);
    expect(screen.getByText(label).className).toContain("author-position-badge");
  });

  it("renders alongside the author-position badge", () => {
    render(
      <PublicationRow
        pub={makePub({
          publicationType: "preprint",
          authorship: { isFirst: true, isLast: false },
          wcmAuthors: [
            {
              name: "Ada First",
              cwid: "aaa1111",
              slug: "ada-first",
              identityImageEndpoint: "",
              isFirst: true,
              isLast: false,
              roleCategory: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Preprint")).toBeTruthy();
    expect(screen.getByText("First author")).toBeTruthy();
  });

  it("renders no type label for an ordinary article", () => {
    render(<PublicationRow pub={makePub({})} />);
    expect(screen.queryByText("Conference abstract")).toBeNull();
    expect(screen.queryByText("Preprint")).toBeNull();
  });
});
