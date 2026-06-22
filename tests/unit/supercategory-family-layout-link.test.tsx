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
const DEFINITION = "Immortalized cell lines derived from tumors, used as in vitro cancer models.";
type PanelMeta = {
  familyLabel: string;
  familySegment: string;
  definition: string | null;
  definitionSource: string | null;
};
const baseMeta: Record<string, PanelMeta> = {
  fam_0007: {
    familyLabel: "Cancer cell lines",
    familySegment: "cancer-cell-lines-fam_0007",
    definition: DEFINITION,
    definitionSource: "generated",
  },
};

function renderLayout(familyMeta: Record<string, PanelMeta> = baseMeta) {
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
    // The definition belongs to the selected-family panel, not the all-work view.
    expect(screen.queryByText(DEFINITION)).toBeNull();
  });

  it("renders the selected family's generated definition with the AI caption", () => {
    mockGet.mockReturnValue("fam_0007");
    renderLayout();
    expect(screen.getByText(DEFINITION)).toBeTruthy();
    expect(screen.getByText("AI-generated definition")).toBeTruthy();
  });

  it("shows the gloss but no AI caption when the source is not 'generated'", () => {
    mockGet.mockReturnValue("fam_0007");
    renderLayout({
      fam_0007: { ...baseMeta.fam_0007, definitionSource: null },
    });
    expect(screen.getByText(DEFINITION)).toBeTruthy();
    expect(screen.queryByText("AI-generated definition")).toBeNull();
  });

  it("renders no definition block when the family has no gloss (flag off / unpopulated)", () => {
    mockGet.mockReturnValue("fam_0007");
    renderLayout({
      fam_0007: { ...baseMeta.fam_0007, definition: null, definitionSource: null },
    });
    // The "View full" signpost still renders; only the gloss is absent.
    expect(screen.getByText(/View full Cancer cell lines method page/)).toBeTruthy();
    expect(screen.queryByText(DEFINITION)).toBeNull();
  });

  // #1168 follow-up — the signpost advertises the family page's per-paper entity
  // badges when the selected family has a specific-entity layer.
  function renderWithEntities(entity: { entityCount?: number; entityKind?: string | null }) {
    return render(
      <SupercategoryFamilyLayout
        supercategorySlug="animal-cell-models"
        supercategoryLabel="Animal & cell models"
        families={[{ ...families[0], ...entity }]}
        familyMeta={baseMeta}
        allWorkPubs={[]}
      />,
    );
  }

  it("enriches the signpost with the entity count + kind noun when entityCount > 0", () => {
    mockGet.mockReturnValue("fam_0007");
    renderWithEntities({ entityCount: 29, entityKind: "organism_or_cells" });
    const link = screen.getByText(/View full Cancer cell lines method page/).closest("a");
    // organism_or_cells → "Cell lines" → lowercased "cell lines".
    expect(link?.textContent).toContain("29 specific cell lines + per-paper usage");
    // The label stays the leading text node (a11y) and the href is unchanged.
    expect(link?.getAttribute("href")).toBe(
      "/methods/animal-cell-models/cancer-cell-lines-fam_0007",
    );
  });

  it("uses the singular noun when exactly one specific entity", () => {
    mockGet.mockReturnValue("fam_0007");
    renderWithEntities({ entityCount: 1, entityKind: "organism_or_cells" });
    const link = screen.getByText(/View full Cancer cell lines method page/).closest("a");
    expect(link?.textContent).toContain("1 specific cell line + per-paper usage");
    expect(link?.textContent).not.toContain("cell lines +");
  });

  it("keeps the plain signpost when entityCount is absent or 0", () => {
    mockGet.mockReturnValue("fam_0007");
    renderWithEntities({}); // entityCount undefined
    const link = screen.getByText(/View full Cancer cell lines method page/).closest("a");
    expect(link?.textContent).not.toContain("specific");
    expect(link?.textContent).not.toContain("per-paper usage");
  });
});
