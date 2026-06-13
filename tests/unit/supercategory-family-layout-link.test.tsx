/**
 * Supercategory method page — the in-panel "View full method page →" signpost.
 *
 * The family rail is an in-page `?family=` deep-link (NOT navigation), so the
 * same family is reachable both as this panel and as its standalone canonical
 * page (`/methods/[sc]/[familySlug]`). Unlike research-area subtopics — which
 * live only as in-page panels — method families are first-class destinations
 * (own canonical + DefinedTerm + sitemap entry), so the panel must point at the
 * canonical page or the two surfaces read as accidental duplicates. These tests
 * lock that link in (and the absence of it when no family is selected).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// `?family=` is read via useSearchParams; only `.get` is used. A controllable
// stub lets each test drive the selected family (or none).
const mockGet = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
}));

// Isolate the header link from the data-fetching children (which fetch in
// useEffect and are out of scope for this test).
vi.mock("@/components/method/family-rail", () => ({ FamilyRail: () => null }));
vi.mock("@/components/method/family-scholars-row", () => ({
  FamilyScholarsRow: () => null,
}));
vi.mock("@/components/method/publication-feed", () => ({
  FamilyPublicationFeed: () => null,
}));
vi.mock("@/components/method/supercategory-all-work-feed", () => ({
  SupercategoryAllWorkFeed: () => <div data-testid="all-work" />,
}));

import { SupercategoryFamilyLayout } from "@/components/method/family-publication-layout";

const families = [
  {
    familyId: "fam_0007",
    familyLabel: "Cancer cell lines",
    scholarCount: 42,
    pubCount: 128,
    exemplarTools: [],
  },
];
const familyMeta = {
  fam_0007: {
    familyLabel: "Cancer cell lines",
    familySegment: "cancer-cell-lines-fam_0007",
  },
};

function renderLayout() {
  return render(
    <SupercategoryFamilyLayout
      supercategorySlug="animal-cell-models"
      supercategoryLabel="Animal & cell models"
      families={families}
      familyMeta={familyMeta}
      allWorkPubs={[]}
    />,
  );
}

describe("SupercategoryFamilyLayout — canonical family-page signpost", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("links the selected family's panel to its standalone method page", () => {
    mockGet.mockReturnValue("fam_0007");
    renderLayout();
    const link = screen.getByText(/View full Cancer cell lines method page/).closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/methods/animal-cell-models/cancer-cell-lines-fam_0007",
    );
  });

  it("shows no signpost when no family is selected (all-work view)", () => {
    mockGet.mockReturnValue(null);
    renderLayout();
    expect(screen.getByTestId("all-work")).toBeTruthy();
    expect(screen.queryByText(/View full .* method page/)).toBeNull();
  });
});
