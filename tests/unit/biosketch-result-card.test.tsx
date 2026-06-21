/**
 * #917 v7 — `BiosketchResultCard` title/body render (`components/edit/biosketch-result-card.tsx`).
 * The follow-up's user-visible behaviors live here: the per-contribution title heading (v7 only),
 * the character badge keyed on the BODY length, and that a title-less entry (v5 / v6 / Personal
 * Statement) renders no heading. These render paths were previously untested.
 *
 * Native DOM assertions (no jest-dom in `tests/setup.ts`): textContent + toBeNull().
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  BiosketchResultCard,
  type BiosketchGenerateResult,
} from "@/components/edit/biosketch-result-card";

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
