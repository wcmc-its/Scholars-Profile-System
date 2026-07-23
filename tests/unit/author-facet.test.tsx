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

function makeItems(n: number): AuthorFacetItem[] {
  return Array.from({ length: n }, (_, i) => ({
    cwid: `c${i}`,
    displayName: `Author ${String(i).padStart(3, "0")}`,
    slug: `author-${i}`,
    count: n - i,
    isActive: false,
    toggleHref: `/search?author=c${i}`,
  }));
}

describe("AuthorFacet — Show all", () => {
  it("caps the collapsed list at 10 and reveals every author on Show all", () => {
    render(<AuthorFacet items={makeItems(60)} totalDistinct={60} />);
    // One <li> per author row (no active items → the "selected" list is empty).
    expect(screen.getAllByRole("listitem")).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "Show all 60" }));

    // Previously capped the reveal at 50 and removed the button, leaving rows
    // 51-60 unreachable; now every sent author shows and nothing stays hidden.
    expect(screen.getAllByRole("listitem")).toHaveLength(60);
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
