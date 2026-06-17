/**
 * `components/edit/reciter-pending-card.tsx` — the dormant-safe ReCiter
 * pending-suggestions nudge. Renders nothing at zero suggestions; a HERO card
 * with a numeric score chip + the exact authorship-confidence tooltip when the
 * top score clears 70; a softer REFERRED list when the top score is only 40–69.
 * The CTA always routes to Publication Manager (ReCiter) in a new tab.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import { ReciterPendingCard } from "@/components/edit/reciter-pending-card";
import { PUBLICATION_MANAGER_URL } from "@/lib/edit/request-a-change";
import type { ReciterSuggestion } from "@/lib/reciter/client";

function suggestion(
  over: Partial<ReciterSuggestion> = {},
): ReciterSuggestion {
  return {
    pmid: "39000001",
    score: 85,
    articleTitle: "A high-confidence candidate paper",
    authors: "Self A, Coauthor B",
    journal: "Nature",
    datePublished: "2025 May 28",
    isPreprint: false,
    ...over,
  };
}

const EXACT_TOOLTIP =
  "Authorship confidence — 85 / 100. ReCiter's empirically-derived estimate of how likely this paper is yours, based on your name, affiliations, co-authors, topics and grants. Higher means more certain.";

describe("ReciterPendingCard — dormant-safe pending-suggestions nudge", () => {
  it("renders null when there are no suggestions (the dormant empty-table state)", () => {
    const { container } = render(<ReciterPendingCard suggestions={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("reciter-pending-bridge")).toBeNull();
  });

  it("shows the HERO with a numeric score chip + the exact authorship tooltip when top score >= 70", () => {
    render(<ReciterPendingCard suggestions={[suggestion({ score: 85 })]} />);
    expect(screen.getByTestId("reciter-pending-bridge")).toBeTruthy();
    const hero = screen.getByTestId("reciter-pending-hero");
    const chip = screen.getByTestId("reciter-pending-score-chip");
    expect(chip.textContent).toContain("85");
    expect(chip.textContent?.toUpperCase()).toContain("SCORE");
    expect(hero.textContent).toContain("A high-confidence candidate paper");
    // The exact tooltip copy is rendered (Radix mounts the content inline in jsdom).
    expect(document.body.textContent).toContain(EXACT_TOOLTIP);
  });

  it("routes the CTA to Publication Manager in a new tab", () => {
    render(<ReciterPendingCard suggestions={[suggestion()]} />);
    const cta = screen.getByTestId("reciter-pending-cta");
    expect(cta.getAttribute("href")).toBe(PUBLICATION_MANAGER_URL);
    expect(cta.getAttribute("target")).toBe("_blank");
    expect(cta.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows the '+ N more' line and pluralizes the title for multiple suggestions", () => {
    render(
      <ReciterPendingCard
        suggestions={[
          suggestion({ pmid: "1", score: 90 }),
          suggestion({ pmid: "2", score: 80 }),
          suggestion({ pmid: "3", score: 75 }),
        ]}
      />,
    );
    expect(screen.getByTestId("reciter-pending-bridge").textContent).toContain(
      "3 publications may be missing from your profile",
    );
    expect(screen.getByTestId("reciter-pending-hero").textContent).toContain(
      "+ 2 more suggested articles in ReCiter",
    );
    expect(screen.getByTestId("reciter-pending-cta").textContent).toContain("Review all 3 in ReCiter");
  });

  it("uses the singular title/CTA copy for exactly one suggestion", () => {
    render(<ReciterPendingCard suggestions={[suggestion({ score: 88 })]} />);
    expect(screen.getByTestId("reciter-pending-bridge").textContent).toContain(
      "1 publication may be missing from your profile",
    );
    // No "+ N more" line for a single hero.
    expect(screen.getByTestId("reciter-pending-hero").textContent).not.toContain("more suggested");
    expect(screen.getByTestId("reciter-pending-cta").textContent).toContain("Review 1 in ReCiter");
  });

  it("falls back to the REFERRED list (no hero) when the top score is 40–69", () => {
    render(
      <ReciterPendingCard
        suggestions={[
          suggestion({ pmid: "10", score: 62, articleTitle: "A mid-confidence candidate" }),
          suggestion({ pmid: "11", score: 45, articleTitle: "Another mid-confidence candidate" }),
        ]}
      />,
    );
    expect(screen.queryByTestId("reciter-pending-hero")).toBeNull();
    expect(screen.queryByTestId("reciter-pending-score-chip")).toBeNull();
    const referred = screen.getByTestId("reciter-pending-referred");
    expect(referred.textContent).toContain("2 possible publications to review in ReCiter");
    expect(referred.textContent).toContain("A mid-confidence candidate");
    expect(referred.textContent).toContain("Another mid-confidence candidate");
  });

  it("uses the green chip for >=70 and an amber chip for 40–69 (chip only ever shown on the hero)", () => {
    const { rerender } = render(<ReciterPendingCard suggestions={[suggestion({ score: 95 })]} />);
    expect(screen.getByTestId("reciter-pending-score-chip").className).toContain("apollo-green");
    // 40–69 has no hero, hence no chip at all (the referred fallback is text-only).
    rerender(<ReciterPendingCard suggestions={[suggestion({ score: 55 })]} />);
    expect(screen.queryByTestId("reciter-pending-score-chip")).toBeNull();
  });

  it("renders a preprint badge when isPreprint is set", () => {
    render(<ReciterPendingCard suggestions={[suggestion({ score: 80, isPreprint: true })]} />);
    expect(screen.getByTestId("reciter-pending-preprint")).toBeTruthy();
  });
});
