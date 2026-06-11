/**
 * Render-level tests for the #879 visible MeSH definition block on the
 * standalone Method family page.
 *
 * The loader-gating tests (`methods-loader-notfound.test.tsx`) stub
 * `getFamilyMeshDefinition` as a static null and only assert control flow
 * (`notFound()` vs `<main>`). This file closes the complementary gap: that when
 * the loader returns a curated definition the page actually RENDERS the NLM
 * scope note + attribution, and when it returns null the scope note is absent.
 *
 * It reuses the loader test's exact mocking pattern (hoisted mock fns for
 * `@/lib/api/methods`, the flags, `next/navigation`, and inert leaf-component
 * stubs) with `isMethodPagesEnabled` pinned true so the page renders, and
 * renders the awaited async RSC element with `@testing-library/react` (the
 * `render(await SomePage())` convention from `slug-requests-page.test.tsx`).
 * The only differences from the loader test: `getFamilyMeshDefinition` is a
 * controllable mock (not a static null stub), and `buildDefinedTermJsonLd` is a
 * passthrough so it can't throw on the populated description.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  mockIsMethodPagesEnabled,
  mockGetFamily,
  mockGetFamilyScholars,
  mockGetDistinctScholarCountForFamily,
  mockGetRepresentativePubsForFamily,
  mockGetFamilyMeshDefinition,
  mockSupercategoryLabel,
  mockNotFound,
} = vi.hoisted(() => ({
  mockIsMethodPagesEnabled: vi.fn(),
  mockGetFamily: vi.fn(),
  mockGetFamilyScholars: vi.fn(),
  mockGetDistinctScholarCountForFamily: vi.fn(),
  mockGetRepresentativePubsForFamily: vi.fn(),
  mockGetFamilyMeshDefinition: vi.fn(),
  mockSupercategoryLabel: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodPagesEnabled: () => mockIsMethodPagesEnabled(),
}));

vi.mock("@/lib/api/methods", () => ({
  getFamily: (...a: unknown[]) => mockGetFamily(...a),
  getFamilyScholars: (...a: unknown[]) => mockGetFamilyScholars(...a),
  getDistinctScholarCountForFamily: (...a: unknown[]) => mockGetDistinctScholarCountForFamily(...a),
  getRepresentativePubsForFamily: (...a: unknown[]) => mockGetRepresentativePubsForFamily(...a),
  // #879 — controllable so each test can drive the definition (vs null) branch.
  getFamilyMeshDefinition: (...a: unknown[]) => mockGetFamilyMeshDefinition(...a),
}));

vi.mock("@/lib/methods/supercategory-labels", () => ({
  supercategoryLabel: (...a: unknown[]) => mockSupercategoryLabel(...a),
}));

// Passthrough (not a constant {}) so the populated scopeNote description can't
// throw, and the JSON-LD <script> renders without affecting the visible block.
vi.mock("@/lib/seo/jsonld", () => ({ buildDefinedTermJsonLd: (...a: unknown[]) => a[0] }));

// Leaf components — inert stubs so only the header block this test cares about
// contributes to the rendered output.
vi.mock("@/components/topic/top-scholars-chip-row", () => ({ TopScholarsChipRow: () => null }));
vi.mock("@/components/shared/spotlight", () => ({ Spotlight: () => null }));
vi.mock("@/components/method/family-publication-layout", () => ({
  FamilyPublicationLayout: () => null,
}));
vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: () => null,
  BreadcrumbItem: () => null,
  BreadcrumbLink: () => null,
  BreadcrumbList: () => null,
  BreadcrumbPage: () => null,
  BreadcrumbSeparator: () => null,
}));

import FamilyPage from "@/app/(public)/methods/[supercategory]/[family]/page";

const FAM = {
  supercategory: "genomics_sequencing",
  supercategorySlug: "genomics-sequencing",
  familyId: "fam_1",
  familyLabel: "CRISPR gene editing",
  familySlug: "crispr-gene-editing-fam_1",
};

const MESH_DEF = {
  descriptorUi: "D019496",
  name: "Cancer Vaccines",
  scopeNote: "Vaccines or candidate vaccines designed to prevent or treat cancer.",
};

const famParams = (supercategory: string, family: string) =>
  Promise.resolve({ supercategory, family });

// FamilyPage is an async RSC; await it to the element tree, then render with
// @testing-library/react (the `render(await SomePage())` convention).
const renderFamilyPage = async () => {
  const element = await FamilyPage({
    params: famParams("genomics-sequencing", "crispr-gene-editing-fam_1"),
  });
  render(element);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockNotFound.mockImplementation(() => {
    throw new Error("__NOT_FOUND__");
  });
  mockIsMethodPagesEnabled.mockReturnValue(true);
  mockSupercategoryLabel.mockReturnValue("Genomics & Sequencing");
  mockGetFamily.mockResolvedValue(FAM);
  mockGetFamilyScholars.mockResolvedValue(null);
  mockGetDistinctScholarCountForFamily.mockResolvedValue(0);
  mockGetRepresentativePubsForFamily.mockResolvedValue([]);
});

describe("FamilyPage — #879 visible MeSH definition block", () => {
  it("renders the curated scope note and NLM MeSH attribution when a definition resolves", async () => {
    mockGetFamilyMeshDefinition.mockResolvedValue(MESH_DEF);

    await renderFamilyPage();

    expect(mockNotFound).not.toHaveBeenCalled();
    // (a) the NLM-authored scope note text is present...
    expect(
      screen.getByText("Vaccines or candidate vaccines designed to prevent or treat cancer."),
    ).toBeTruthy();
    // ...and the attribution line carries both "NLM MeSH" and the descriptor name.
    // The line is a single text node ("— NLM MeSH: “Cancer Vaccines”"), so match
    // on substrings.
    expect(screen.getByText(/NLM MeSH/)).toBeTruthy();
    expect(screen.getByText(/Cancer Vaccines/)).toBeTruthy();
  });

  it("omits the scope note entirely when no definition resolves (null)", async () => {
    mockGetFamilyMeshDefinition.mockResolvedValue(null);

    await renderFamilyPage();

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(
      screen.queryByText("Vaccines or candidate vaccines designed to prevent or treat cancer."),
    ).toBeNull();
    expect(screen.queryByText(/NLM MeSH/)).toBeNull();
  });
});
