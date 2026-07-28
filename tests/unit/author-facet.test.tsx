/**
 * components/search/author-facet.tsx — "Show all N" reveals every author
 * bucket the server sent, not a second 50-cap that stranded rows 51+ and
 * removed its own button (#1514).
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// The popover is irrelevant to the cap logic — render its trigger children only.
vi.mock("@/components/scholar/person-popover", () => ({
  PersonPopover: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { AuthorFacet, type AuthorFacetItem } from "@/components/search/author-facet";

const APPEND_BASE = "/search?q=leukemia&type=publications&wcmAuthor=";

// #1995 — unselected buckets ship no `toggleHref`; the row derives it.
function makeItems(n: number): AuthorFacetItem[] {
  return Array.from({ length: n }, (_, i) => ({
    cwid: `c${i}`,
    displayName: `Author ${String(i).padStart(3, "0")}`,
    count: n - i,
    isActive: false,
  }));
}

describe("AuthorFacet — Show all", () => {
  it("caps the collapsed list at 10 and reveals every author on Show all", () => {
    render(
      <AuthorFacet items={makeItems(60)} totalDistinct={60} appendBase={APPEND_BASE} />,
    );
    // One <li> per author row (no active items → the "selected" list is empty).
    expect(screen.getAllByRole("listitem")).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));

    // Previously capped the reveal at 50 and removed the button, leaving rows
    // 51-60 unreachable; now every sent author shows and nothing stays hidden.
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  // #1995 — the server stopped shipping a resolved URL per bucket; an
  // unselected row appends its own cwid to the shared prefix, and a selected
  // row still uses the explicit removal href the server sent.
  it("derives an unselected bucket's href and honours a selected bucket's", () => {
    render(
      <AuthorFacet
        items={[
          { cwid: "abc1234", displayName: "Author One", count: 5, isActive: false },
          {
            cwid: "def5678",
            displayName: "Author Two",
            count: 3,
            isActive: true,
            toggleHref: "/search?q=leukemia&type=publications",
          },
        ]}
        totalDistinct={2}
        appendBase={APPEND_BASE}
      />,
    );
    expect(
      screen.getByRole("link", { name: /Author One/ }).getAttribute("href"),
    ).toBe(`${APPEND_BASE}abc1234`);
    expect(
      screen.getByRole("link", { name: /Author Two/ }).getAttribute("href"),
    ).toBe("/search?q=leukemia&type=publications");
  });
});
