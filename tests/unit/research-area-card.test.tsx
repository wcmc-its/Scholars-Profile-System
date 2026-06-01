/**
 * Issue #638 — `ResearchAreaCard` behavioral tests.
 *
 * Pins:
 *   - Renders nothing when no research area matched (state !== "matches").
 *   - Eyebrow, primary name, "{scholars} · {pubs}" counts, and the whole-card
 *     primary link → the matched topic page.
 *   - "N more areas" trigger: pluralization (1 → "1 more area"), omitted when
 *     there are no additional areas, opens an anchored popover (does NOT
 *     navigate) listing each secondary area's name + counts + per-row link.
 *   - "See all matches →" overflow row only when overflowCount > 0, → /search.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResearchAreaCard } from "@/components/search/research-area-card";
import type { TaxonomyMatch, TaxonomyMatchResult } from "@/lib/api/search-taxonomy";

function area(over: Partial<TaxonomyMatch> = {}): TaxonomyMatch {
  return {
    entityType: "parentTopic",
    id: "womens-health",
    name: "Women's Health & Reproductive Medicine",
    parentTopicId: null,
    parentTopicLabel: null,
    href: "/topics/womens-health",
    scholarCount: 421,
    publicationCount: 559,
    similarity: 0.9,
    ...over,
  };
}

function result(over: Partial<Extract<TaxonomyMatchResult, { state: "matches" }>> = {}): TaxonomyMatchResult {
  return {
    state: "matches",
    primary: area(),
    secondary: [],
    overflowCount: 0,
    query: "Reproductive Medicine",
    meshResolution: null,
    ...over,
  };
}

describe("ResearchAreaCard", () => {
  it("renders nothing when no research area matched", () => {
    const { container } = render(
      <ResearchAreaCard result={{ state: "none", meshResolution: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the eyebrow, name, and scholar/pub counts", () => {
    render(<ResearchAreaCard result={result()} />);
    expect(screen.getByText("Research area at WCM")).toBeTruthy();
    expect(
      screen.getByText("Women's Health & Reproductive Medicine"),
    ).toBeTruthy();
    expect(screen.getByText(/421 scholars/)).toBeTruthy();
    expect(screen.getByText(/559 pubs/)).toBeTruthy();
  });

  it("makes the whole card a link to the topic page", () => {
    render(<ResearchAreaCard result={result()} />);
    const link = screen.getByRole("link", {
      name: /View Women's Health & Reproductive Medicine, a research area at WCM/i,
    });
    expect(link.getAttribute("href")).toBe("/topics/womens-health");
  });

  it("omits the 'more areas' trigger when there are no additional areas", () => {
    render(<ResearchAreaCard result={result()} />);
    expect(screen.queryByRole("button", { name: /more research area/i })).toBeNull();
    expect(screen.queryByText(/more area/)).toBeNull();
  });

  it("pluralizes 'N more areas' and opens a popover that does not navigate", () => {
    render(
      <ResearchAreaCard
        result={result({
          secondary: [
            area({ id: "obgyn", name: "Obstetrics & Gynecology", href: "/topics/obgyn", scholarCount: 88, publicationCount: 120 }),
            area({ id: "fertility", name: "Fertility Preservation", href: "/topics/fertility", scholarCount: 12, publicationCount: 30 }),
          ],
          overflowCount: 0,
        })}
      />,
    );
    const trigger = screen.getByRole("button", { name: /show 2 more research areas/i });
    expect(trigger.textContent).toContain("2 more areas");
    // The trigger is a popover button, not a navigation link.
    expect(trigger.tagName.toLowerCase()).toBe("button");
    fireEvent.click(trigger);
    const row = screen.getByRole("link", {
      name: /View Obstetrics & Gynecology, a research area at WCM/i,
    });
    expect(row.getAttribute("href")).toBe("/topics/obgyn");
    expect(screen.getByText("Fertility Preservation")).toBeTruthy();
    // No overflow row when overflowCount is 0.
    expect(screen.queryByText(/See all matches/i)).toBeNull();
  });

  it("uses the singular 'area' when exactly one additional area", () => {
    render(
      <ResearchAreaCard
        result={result({
          secondary: [area({ id: "obgyn", name: "Obstetrics & Gynecology", href: "/topics/obgyn" })],
          overflowCount: 0,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /show 1 more research area$/i })).toBeTruthy();
    expect(screen.getByText("1 more area")).toBeTruthy();
  });

  it("renders a 'See all matches →' overflow row → /search when overflowCount > 0", () => {
    render(
      <ResearchAreaCard
        result={result({
          secondary: [area({ id: "obgyn", name: "Obstetrics & Gynecology", href: "/topics/obgyn" })],
          overflowCount: 4,
          query: "Reproductive Medicine",
        })}
      />,
    );
    // moreCount = secondary(1) + overflow(4) = 5
    fireEvent.click(screen.getByRole("button", { name: /show 5 more research areas/i }));
    const seeAll = screen.getByRole("link", { name: /See all matches/i });
    expect(seeAll.getAttribute("href")).toBe(
      "/search?q=Reproductive%20Medicine",
    );
  });
});
