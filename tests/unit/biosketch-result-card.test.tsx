/**
 * #917 v7 — `BiosketchResultCard` title/body render (`components/edit/biosketch-result-card.tsx`).
 * The follow-up's user-visible behaviors live here: the per-contribution title heading (v7 only),
 * the character badge keyed on the BODY length, and that a title-less entry (v5 / v6 / Personal
 * Statement) renders no heading. These render paths were previously untested.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`): textContent + toBeNull().
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import {
  BiosketchResultCard,
  type BiosketchGenerateResult,
} from "@/components/edit/biosketch-result-card";
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";

function result(over: Partial<BiosketchGenerateResult> = {}): BiosketchGenerateResult {
  return {
    mode: "contributions",
    entries: [{ title: "CAR-T resistance", body: "We studied resistance." }],
    model: "us.anthropic.claude-opus-4-8",
    overflow: [],
    removedCount: 0,
    products: null,
    sources: null,
    generationId: null,
    ...over,
  };
}

describe("BiosketchResultCard — v7 titles", () => {
  it("renders the title heading for a titled (v7) entry", () => {
    render(<BiosketchResultCard result={result()} />);
    expect(screen.getByTestId("biosketch-entry-title-0").textContent).toContain("CAR-T resistance");
    expect(screen.getByTestId("biosketch-entry-text-0").textContent).toContain(
      "We studied resistance.",
    );
  });

  it("renders no heading for a title-less entry (v5 / v6 / statement)", () => {
    render(<BiosketchResultCard result={result({ entries: [{ title: "", body: "Body." }] })} />);
    expect(screen.queryByTestId("biosketch-entry-title-0")).toBeNull();
    expect(screen.getByTestId("biosketch-entry-text-0").textContent).toContain("Body.");
  });

  it("the character badge keys on the body length, not title + body", () => {
    render(
      <BiosketchResultCard
        result={result({ entries: [{ title: "An intentionally long heading", body: "abc" }] })}
      />,
    );
    // body "abc" = 3 chars against the 2,000 contribution cap (NOT title+body).
    expect(screen.getByTestId("biosketch-entry-count-0").textContent).toContain("3/2,000");
  });
});

describe("BiosketchResultCard — #2653 v8 Personal Statement products", () => {
  // Unmapped by design for a statement (contributionIndex null on every product).
  const PRODUCTS: BiosketchProducts = {
    related: [
      {
        pmid: "11",
        title: "Alpha study",
        venue: null,
        year: 2019,
        contributionIndex: null,
        why: "",
      },
    ],
    otherSignificant: [],
    relatedFromAims: true,
  };

  it("renders the products with the statement caption and no contribution-mapping label", () => {
    const { unmount } = render(
      <BiosketchResultCard
        result={result({
          mode: "personal_statement",
          entries: [{ title: "", body: "My statement (Smith 2019)." }],
          products: PRODUCTS,
        })}
      />,
    );
    const card = within(screen.getByTestId("biosketch-result"));
    const section = within(card.getByTestId("biosketch-products"));
    expect(section.getByText(/A parenthetical reference in the statement/)).toBeTruthy();
    expect(section.getByTestId("biosketch-product-11").textContent).toContain("Alpha study");
    // showMapping=false: the "Not mapped to a contribution" group label is omitted.
    expect(section.queryByText(/Not mapped to a contribution/)).toBeNull();
    expect(section.queryByText(/mapped to your contributions/)).toBeNull();
    unmount();

    // Contrast: the same unmapped products in Contributions mode DO carry the mapping label,
    // so the absence above is the statement's doing, not the fixture's.
    render(<BiosketchResultCard result={result({ products: PRODUCTS })} />);
    const contrib = within(screen.getByTestId("biosketch-products"));
    expect(contrib.getByText(/Not mapped to a contribution/)).toBeTruthy();
    expect(contrib.getByText(/mapped to your contributions/)).toBeTruthy();
  });
});

describe("BiosketchResultCard — SciENcv worksheet link (#2652)", () => {
  it("links to the worksheet for a persisted generation", () => {
    const { container } = render(
      <BiosketchResultCard result={result({ generationId: "gen-42" })} />,
    );
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="biosketch-open-worksheet"]',
    );
    expect(link?.getAttribute("href")).toBe("/edit/biosketch/worksheet?id=gen-42");
  });

  it("renders no link when the run did not persist (generationId null)", () => {
    const { container } = render(<BiosketchResultCard result={result()} />);
    expect(container.querySelector('[data-testid="biosketch-open-worksheet"]')).toBeNull();
  });
});
