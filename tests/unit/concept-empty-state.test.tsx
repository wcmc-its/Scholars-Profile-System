/**
 * Issue #298 §4.1 — `ConceptEmptyState` suppresses its "Search broadly" CTA when
 * the `ConceptFallbackResults` block co-renders below (its "View all N" link
 * replaces it). The CTA stays for graceful degradation when the fallback is
 * empty or suppressed. (Pre-#298 #274 behavior is locked in too.)
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ConceptEmptyState } from "@/components/search/concept-empty-state";

const BROADEN = "/search?q=authorship&mesh=off";

describe("ConceptEmptyState — §4.1 omitCta", () => {
  it("renders the CTA by default (broadCount > 0, no co-render)", () => {
    render(
      <ConceptEmptyState
        query="authorship"
        descriptorName="Authorship"
        broadCount={47}
        broadenHref={BROADEN}
      />,
    );
    expect(
      screen.getByRole("link", { name: /Search broadly for .*authorship.* — 47 results/ }),
    ).toBeTruthy();
  });

  it("omits the CTA when omitCta is true (zero-trigger co-render below)", () => {
    render(
      <ConceptEmptyState
        query="authorship"
        descriptorName="Authorship"
        broadCount={47}
        broadenHref={BROADEN}
        omitCta
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    // The explanatory header still renders.
    expect(screen.getByText(/No publications tagged with this concept/)).toBeTruthy();
  });

  it("keeps the CTA hidden when broadCount is 0 regardless of omitCta", () => {
    render(
      <ConceptEmptyState
        query="authorship"
        descriptorName="Authorship"
        broadCount={0}
        broadenHref={BROADEN}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/A broad-text search for the phrase also returns nothing/)).toBeTruthy();
  });
});
