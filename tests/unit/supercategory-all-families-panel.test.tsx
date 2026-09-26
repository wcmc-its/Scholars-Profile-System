/**
 * Phase 4 — the method category page's "All families" panel and rail row.
 *
 *   - TAXONOMY_FEED_LOAD_MORE off: the fixed 12-newest list (unchanged);
 *     on: the paged category-wide feed, and a selected family's feed pages
 *     with Load more.
 *   - The "All families" rail row carries the DISTINCT category count it is
 *     given (never a sum of the family rows).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}));
vi.mock("@/components/method/family-scholars-row", () => ({ FamilyScholarsRow: () => null }));
vi.mock("@/components/taxonomy/publication-feed", () => ({
  FamilyPublicationFeed: (p: { loadMore?: boolean }) => (
    <div data-testid="family-feed">{p.loadMore ? "load-more" : "paged"}</div>
  ),
  CategoryPublicationFeed: (p: { supercategorySlug: string }) => (
    <div data-testid="category-feed">{p.supercategorySlug}</div>
  ),
}));
vi.mock("@/components/method/supercategory-all-work-feed", () => ({
  SupercategoryAllWorkFeed: () => <div data-testid="all-work" />,
}));

import { SupercategoryRailLayout } from "@/components/method/supercategory-rail-layout";

const families = [
  { familyId: "fam_0001", familyLabel: "CRISPR", scholarCount: 4, pubCount: 30, exemplarTools: [] },
  { familyId: "fam_0002", familyLabel: "Antibodies", scholarCount: 3, pubCount: 20, exemplarTools: [] },
];
const familyMeta = {
  fam_0001: { familyLabel: "CRISPR", familySegment: "crispr-fam_0001", definition: null, definitionSource: null },
  fam_0002: { familyLabel: "Antibodies", familySegment: "antibodies-fam_0002", definition: null, definitionSource: null },
};
const renderLayout = (loadMore: boolean) =>
  render(
    <SupercategoryRailLayout
      supercategorySlug="reagents"
      supercategoryLabel="Reagents"
      families={families}
      familyMeta={familyMeta}
      allWorkPubs={[]}
      allPubCount={42}
      loadMore={loadMore}
    />,
  );

beforeEach(() => mockGet.mockReset());

describe("All families panel", () => {
  it("flag off: the fixed representative list", () => {
    mockGet.mockReturnValue(null);
    renderLayout(false);
    expect(screen.getByTestId("all-work")).toBeTruthy();
    expect(screen.queryByTestId("category-feed")).toBeNull();
  });

  it("flag on: the category-wide feed", () => {
    mockGet.mockReturnValue(null);
    renderLayout(true);
    expect(screen.getByTestId("category-feed").textContent).toBe("reagents");
    expect(screen.queryByTestId("all-work")).toBeNull();
  });

  it("a selected family's feed follows the flag", () => {
    mockGet.mockReturnValue("fam_0001");
    renderLayout(true);
    expect(screen.getByTestId("family-feed").textContent).toBe("load-more");
  });

  it("the All families row shows the distinct count, not the row sum (50)", () => {
    mockGet.mockReturnValue(null);
    renderLayout(false);
    const rail = screen.getAllByRole("complementary")[0];
    const all = within(rail).getByText("All families").closest("button")!;
    expect(all.textContent).toContain("42");
    expect(all.textContent).not.toContain("50");
  });
});
