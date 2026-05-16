import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Spotlight } from "@/components/shared/spotlight";
import type { SpotlightCard, SpotlightData } from "@/lib/api/spotlight";

// Issue #337 — Spotlight cards surface citation counts inline on the
// bibliographic line, mirroring the publication-feed PublicationMeta
// convention: `{N.toLocaleString()} citations`, omitted when 0. These tests
// pin the render guard and the `·` separator handling across the cases
// where journal / year may or may not be present.

function makeCard(over: Partial<SpotlightCard> = {}): SpotlightCard {
  return {
    pmid: "12345678",
    kicker: "Test Topic",
    kickerHref: null,
    title: "A Representative Publication Title",
    journal: "Nature Medicine",
    year: 2024,
    citationCount: 0,
    pubmedUrl: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
    doi: null,
    authors: [],
    ...over,
  };
}

function makeData(cards: SpotlightCard[]): SpotlightData {
  return {
    cards,
    totalCount: cards.length,
    viewAllHref: "/topics/test#publications",
  };
}

describe("Spotlight — inline citation count (issue #337)", () => {
  it("renders `{N} citations` when citationCount > 0", () => {
    const { container } = render(
      <Spotlight data={makeData([makeCard({ citationCount: 42 })])} />,
    );
    expect(container.textContent).toContain("42 citations");
  });

  it("omits the citation count entirely when citationCount is 0", () => {
    const { container } = render(
      <Spotlight data={makeData([makeCard({ citationCount: 0 })])} />,
    );
    expect(container.textContent).not.toContain("citations");
  });

  it("formats large counts with thousands separators (toLocaleString)", () => {
    const { container } = render(
      <Spotlight data={makeData([makeCard({ citationCount: 1234 })])} />,
    );
    expect(container.textContent).toContain("1,234 citations");
  });

  it("places the count after journal · year with the same · separator", () => {
    const { container } = render(
      <Spotlight
        data={makeData([
          makeCard({ journal: "Cell", year: 2023, citationCount: 7 }),
        ])}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Cell\s*·\s*2023\s*·\s*7 citations/);
    expect(text.indexOf("7 citations")).toBeGreaterThan(text.indexOf("2023"));
  });

  it("renders the count with no leading separator when journal and year are both absent", () => {
    const { container } = render(
      <Spotlight
        data={makeData([
          makeCard({ journal: null, year: null, citationCount: 9 }),
        ])}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("9 citations");
    expect(text).not.toMatch(/·\s*9 citations/);
  });

  it("separates the count from a lone journal or a lone year with a middot", () => {
    const { container: journalOnly } = render(
      <Spotlight
        data={makeData([
          makeCard({ journal: "Lancet", year: null, citationCount: 3 }),
        ])}
      />,
    );
    expect(journalOnly.textContent).toMatch(/Lancet\s*·\s*3 citations/);

    const { container: yearOnly } = render(
      <Spotlight
        data={makeData([
          makeCard({ journal: null, year: 2022, citationCount: 3 }),
        ])}
      />,
    );
    expect(yearOnly.textContent).toMatch(/2022\s*·\s*3 citations/);
  });
});
