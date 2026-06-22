/**
 * Loader-level `notFound()` integration tests for the standalone Method pages
 * (standalone Method pages plan §9, edge cases E1–E4).
 *
 * The overlay PRIMITIVE (`isFamilyPubliclyVisible` / `loadFamilyOverlayGate`) is
 * unit-tested in `methods-overlay.test.ts`, and the rollup gating invariant (a
 * suppressed family contributes neither a roster row nor a pmid) in
 * `methods-rollup.test.ts`. Neither asserts what the ROUTE boundary does with
 * those signals. This file closes that gap: that the page loaders themselves
 * translate the gate into `notFound()` so nothing leaks publicly —
 *
 *   - E1  `METHODS_LENS_PAGES` off          → `notFound()` for every `/methods/**`;
 *                                             the data resolvers are never even
 *                                             queried, and `generateMetadata`
 *                                             returns a neutral title (no JSON/SEO leak).
 *   - E2  #800-suppressed family            → `getFamily()` resolves to null
 *                                             (overlay gate inside the resolver) →
 *                                             family page `notFound()`.
 *   - E3  #801-sensitive family (gate on)   → same: `getFamily()` → null → `notFound()`.
 *   - E4  all-suppressed/all-sensitive sc   → `getSupercategory()` resolves to null
 *                                             (empty post-gate roster) → `notFound()`;
 *                                             plus the defensive empty-rollup guard.
 *
 * E2 and E3 are indistinguishable at the loader boundary — both surface as a null
 * `getFamily()` resolution; the suppression-vs-sensitivity distinction lives in the
 * resolver/overlay and is covered by `methods-overlay.test.ts`. The loader's only
 * contract, asserted here, is to honor a null/empty resolution with `notFound()`
 * and never render a page for it. A happy-path control proves the assertions
 * discriminate (the loaders DON'T blanket-`notFound()`).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockIsMethodPagesEnabled,
  mockGetSupercategory,
  mockGetSupercategoryRollup,
  mockGetTopScholarsForSupercategory,
  mockGetFamily,
  mockGetFamilyScholars,
  mockGetDistinctScholarCountForFamily,
  mockGetRepresentativePubsForFamily,
  mockGetDistinctPmidCountForFamily,
  mockSpotlight,
  mockIsScholarListExportEnabled,
  mockSupercategoryLabel,
  mockNotFound,
} = vi.hoisted(() => ({
  mockIsMethodPagesEnabled: vi.fn(),
  mockGetSupercategory: vi.fn(),
  mockGetSupercategoryRollup: vi.fn(),
  mockGetTopScholarsForSupercategory: vi.fn(),
  mockGetFamily: vi.fn(),
  mockGetFamilyScholars: vi.fn(),
  mockGetDistinctScholarCountForFamily: vi.fn(),
  mockGetRepresentativePubsForFamily: vi.fn(),
  mockGetDistinctPmidCountForFamily: vi.fn(),
  mockSpotlight: vi.fn(() => null),
  mockIsScholarListExportEnabled: vi.fn(),
  mockSupercategoryLabel: vi.fn(),
  mockNotFound: vi.fn(() => {
    throw new Error("__NOT_FOUND__");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mockNotFound }));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsFamilyDefinitionsOn: () => false,
  isMethodPagesEnabled: () => mockIsMethodPagesEnabled(),
}));

vi.mock("@/lib/api/methods", () => ({
  getSupercategory: (...a: unknown[]) => mockGetSupercategory(...a),
  getSupercategoryRollup: (...a: unknown[]) => mockGetSupercategoryRollup(...a),
  getTopScholarsForSupercategory: (...a: unknown[]) => mockGetTopScholarsForSupercategory(...a),
  getFamily: (...a: unknown[]) => mockGetFamily(...a),
  getFamilyScholars: (...a: unknown[]) => mockGetFamilyScholars(...a),
  getDistinctScholarCountForFamily: (...a: unknown[]) => mockGetDistinctScholarCountForFamily(...a),
  getRepresentativePubsForFamily: (...a: unknown[]) => mockGetRepresentativePubsForFamily(...a),
  // #1166 — the FamilyPage also fetches the cell-line entity layer + the family's
  // distinct-pmid total (flag-gated; []/0 when off). Stub them so the loader's
  // Promise.all resolves in the test.
  getFamilyCellLineEntities: () => Promise.resolve([]),
  getDistinctPmidCountForFamily: (...a: unknown[]) => mockGetDistinctPmidCountForFamily(...a),
  // The supercategory loader also fetches the per-family entity summaries that
  // drive the "View full method page" signpost (flag-gated; {} when off). Stub so
  // the loader's Promise.all resolves.
  getSupercategoryFamilyEntitySummaries: () => Promise.resolve({}),
}));

vi.mock("@/lib/export/scholar-export-flags", () => ({
  isScholarListExportEnabled: () => mockIsScholarListExportEnabled(),
}));

vi.mock("@/lib/methods/supercategory-labels", () => ({
  supercategoryLabel: (...a: unknown[]) => mockSupercategoryLabel(...a),
}));

vi.mock("@/lib/seo/jsonld", () => ({ buildDefinedTermJsonLd: () => ({}) }));

// Leaf components — replaced with inert stubs so the loaders' control flow (not
// the rendered tree) is what's under test. Element creation does not invoke them.
vi.mock("@/components/scholar-export/scholar-list-export-button", () => ({
  ScholarListExportButton: () => null,
}));
vi.mock("@/components/topic/top-scholars-chip-row", () => ({ TopScholarsChipRow: () => null }));
vi.mock("@/components/shared/spotlight", () => ({ Spotlight: mockSpotlight }));
vi.mock("@/components/method/family-publication-layout", () => ({
  SupercategoryFamilyLayout: () => null,
  FamilyPublicationLayout: () => null,
}));
vi.mock("@/components/method/cell-line-rail", () => ({ CellLineRail: () => null }));
vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: () => null,
  BreadcrumbItem: () => null,
  BreadcrumbLink: () => null,
  BreadcrumbList: () => null,
  BreadcrumbPage: () => null,
  BreadcrumbSeparator: () => null,
}));

import SupercategoryPage, {
  generateMetadata as supercategoryMetadata,
} from "@/app/(public)/methods/[supercategory]/page";
import FamilyPage, {
  generateMetadata as familyMetadata,
} from "@/app/(public)/methods/[supercategory]/[family]/page";

// --- fixtures -------------------------------------------------------------
const SC = {
  id: "genomics_sequencing",
  slug: "genomics-sequencing",
  label: "Genomics & Sequencing",
  description: "Methods for reading and engineering nucleic acids.",
};
const SC_ROLLUP_NONEMPTY = {
  families: [
    {
      familyId: "fam_1",
      familyLabel: "CRISPR gene editing",
      familySlug: "crispr-gene-editing-fam_1",
      supercategory: "genomics_sequencing",
      scholarCount: 12,
      pmidCountSum: 40,
      pubCount: 33,
      exemplarTools: ["Cas9"],
    },
  ],
  allWorkPubs: [],
};
const SC_ROLLUP_EMPTY = { families: [], allWorkPubs: [] };

const FAM = {
  supercategory: "genomics_sequencing",
  supercategorySlug: "genomics-sequencing",
  familyId: "fam_1",
  familyLabel: "CRISPR gene editing",
  familySlug: "crispr-gene-editing-fam_1",
};

const scParams = (supercategory: string) => Promise.resolve({ supercategory });
const famParams = (supercategory: string, family: string) =>
  Promise.resolve({ supercategory, family });

const asElement = (v: unknown) => v as { type: unknown; props: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  // re-arm the throwing notFound impl (clearAllMocks wipes call data, not impl,
  // but be explicit so a future switch to resetAllMocks can't silently neuter it)
  mockNotFound.mockImplementation(() => {
    throw new Error("__NOT_FOUND__");
  });
  // Defaults: lens on, resolvers succeed — each gating test overrides one knob.
  mockIsMethodPagesEnabled.mockReturnValue(true);
  mockIsScholarListExportEnabled.mockReturnValue(false);
  mockSupercategoryLabel.mockReturnValue(SC.label);
  mockGetSupercategory.mockResolvedValue(SC);
  mockGetSupercategoryRollup.mockResolvedValue(SC_ROLLUP_NONEMPTY);
  mockGetTopScholarsForSupercategory.mockResolvedValue(null);
  mockGetFamily.mockResolvedValue(FAM);
  mockGetFamilyScholars.mockResolvedValue(null);
  mockGetDistinctScholarCountForFamily.mockResolvedValue(0);
  mockGetRepresentativePubsForFamily.mockResolvedValue([]);
  mockGetDistinctPmidCountForFamily.mockResolvedValue(0);
});

describe("SupercategoryPage loader — notFound() gating (§9 E1/E4)", () => {
  it("E1: METHODS_LENS_PAGES off → notFound() and the data resolvers are never queried", async () => {
    mockIsMethodPagesEnabled.mockReturnValue(false);
    await expect(SupercategoryPage({ params: scParams("genomics-sequencing") })).rejects.toThrow(
      "__NOT_FOUND__",
    );
    expect(mockGetSupercategory).not.toHaveBeenCalled();
    expect(mockGetSupercategoryRollup).not.toHaveBeenCalled();
  });

  it("E4: unknown / all-suppressed / all-sensitive supercategory (resolver → null) → notFound()", async () => {
    mockGetSupercategory.mockResolvedValue(null);
    await expect(SupercategoryPage({ params: scParams("all-gated") })).rejects.toThrow(
      "__NOT_FOUND__",
    );
    // Never proceeds to the rollup once the supercategory itself is gated out.
    expect(mockGetSupercategoryRollup).not.toHaveBeenCalled();
  });

  it("E4: supercategory resolves but post-gate family roster is empty → notFound() (defensive guard)", async () => {
    mockGetSupercategory.mockResolvedValue(SC);
    mockGetSupercategoryRollup.mockResolvedValue(SC_ROLLUP_EMPTY);
    await expect(SupercategoryPage({ params: scParams("genomics-sequencing") })).rejects.toThrow(
      "__NOT_FOUND__",
    );
  });

  it("control: a visible supercategory with a non-empty roster renders <main> and never calls notFound()", async () => {
    const result = asElement(await SupercategoryPage({ params: scParams("genomics-sequencing") }));
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(result.type).toBe("main");
    expect(mockGetSupercategory).toHaveBeenCalledWith("genomics-sequencing");
  });
});

describe("FamilyPage loader — notFound() gating (§9 E1/E2/E3)", () => {
  it("E1: METHODS_LENS_PAGES off → notFound() and getFamily() is never queried", async () => {
    mockIsMethodPagesEnabled.mockReturnValue(false);
    await expect(
      FamilyPage({ params: famParams("genomics-sequencing", "crispr-gene-editing-fam_1") }),
    ).rejects.toThrow("__NOT_FOUND__");
    expect(mockGetFamily).not.toHaveBeenCalled();
  });

  it("E2: a #800-suppressed family (getFamily → null) → notFound()", async () => {
    // Suppression is enforced inside getFamily()'s overlay gate; at the loader
    // boundary it surfaces as a null resolution. (Suppression-vs-sensitivity
    // distinction is covered in methods-overlay.test.ts.)
    mockGetFamily.mockResolvedValue(null);
    await expect(
      FamilyPage({ params: famParams("computational-statistical", "descriptive-statistics-fam_9") }),
    ).rejects.toThrow("__NOT_FOUND__");
  });

  it("E3: a #801-sensitive family with the gate on (getFamily → null) → notFound()", async () => {
    mockGetFamily.mockResolvedValue(null);
    await expect(
      FamilyPage({ params: famParams("animal-cell-models", "gemm-fam_4") }),
    ).rejects.toThrow("__NOT_FOUND__");
  });

  it("E6: an unknown / stale family slug that resolves to null → notFound()", async () => {
    mockGetFamily.mockResolvedValue(null);
    await expect(
      FamilyPage({ params: famParams("genomics-sequencing", "no-such-family-fam_999") }),
    ).rejects.toThrow("__NOT_FOUND__");
  });

  it("control: a visible family renders <main> and never calls notFound()", async () => {
    const result = asElement(
      await FamilyPage({ params: famParams("genomics-sequencing", "crispr-gene-editing-fam_1") }),
    );
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(result.type).toBe("main");
    expect(mockGetFamily).toHaveBeenCalledWith("genomics-sequencing", "crispr-gene-editing-fam_1");
  });
});

describe("FamilyPage — Spotlight volume gate (spec v2.1 §5.1)", () => {
  // Recursively locate an element of `type` in a rendered element tree. The page
  // is an async server component; `{cond && <Spotlight/>}` yields `false` (no
  // element) when suppressed, so presence/absence is exactly what the gate asserts.
  const findElement = (node: unknown, type: unknown): unknown => {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findElement(child, type);
        if (found) return found;
      }
      return null;
    }
    const el = node as { type?: unknown; props?: { children?: unknown } };
    if (el.type === type) return el;
    return el.props?.children ? findElement(el.props.children, type) : null;
  };

  const pub = (i: number) => ({
    pmid: `pmid_${i}`,
    title: `Representative paper ${i}`,
    journal: "J. Test",
    year: 2024,
    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/pmid_${i}`,
    doi: null,
    authors: [],
  });
  const params = () => famParams("genomics-sequencing", "crispr-gene-editing-fam_1");

  it("renders Spotlight when ≥3 cards AND distinct-pmid total ≥ 12", async () => {
    mockGetRepresentativePubsForFamily.mockResolvedValue([pub(1), pub(2), pub(3)]);
    mockGetDistinctPmidCountForFamily.mockResolvedValue(12);
    const result = asElement(await FamilyPage({ params: params() }));
    expect(findElement(result, mockSpotlight)).not.toBeNull();
  });

  it("suppresses Spotlight for a sparse family (distinct-pmid total < 12)", async () => {
    mockGetRepresentativePubsForFamily.mockResolvedValue([pub(1), pub(2), pub(3)]);
    mockGetDistinctPmidCountForFamily.mockResolvedValue(11);
    const result = asElement(await FamilyPage({ params: params() }));
    expect(findElement(result, mockSpotlight)).toBeNull();
  });

  it("suppresses Spotlight when fewer than 3 representative cards", async () => {
    mockGetRepresentativePubsForFamily.mockResolvedValue([pub(1), pub(2)]);
    mockGetDistinctPmidCountForFamily.mockResolvedValue(40);
    const result = asElement(await FamilyPage({ params: params() }));
    expect(findElement(result, mockSpotlight)).toBeNull();
  });
});

describe("generateMetadata — no SEO/title leak when gated (§9 E1)", () => {
  it("supercategory, lens off → neutral title and getSupercategory never queried", async () => {
    mockIsMethodPagesEnabled.mockReturnValue(false);
    const meta = await supercategoryMetadata({ params: scParams("genomics-sequencing") });
    expect(meta.title).toBe("Method not found");
    expect(meta.alternates).toBeUndefined();
    expect(mockGetSupercategory).not.toHaveBeenCalled();
  });

  it("supercategory, resolver → null → neutral title, no canonical", async () => {
    mockGetSupercategory.mockResolvedValue(null);
    const meta = await supercategoryMetadata({ params: scParams("all-gated") });
    expect(meta.title).toBe("Method not found");
    expect(meta.alternates).toBeUndefined();
  });

  it("supercategory, visible → real title + self-canonical", async () => {
    const meta = await supercategoryMetadata({ params: scParams("genomics-sequencing") });
    expect(meta.title).toContain(SC.label);
    expect(meta.alternates?.canonical).toBe("/methods/genomics-sequencing");
  });

  it("family, lens off → neutral title and getFamily never queried", async () => {
    mockIsMethodPagesEnabled.mockReturnValue(false);
    const meta = await familyMetadata({
      params: famParams("genomics-sequencing", "crispr-gene-editing-fam_1"),
    });
    expect(meta.title).toBe("Method not found");
    expect(meta.alternates).toBeUndefined();
    expect(mockGetFamily).not.toHaveBeenCalled();
  });

  it("family, resolver → null → neutral title, no canonical", async () => {
    mockGetFamily.mockResolvedValue(null);
    const meta = await familyMetadata({
      params: famParams("genomics-sequencing", "no-such-family-fam_999"),
    });
    expect(meta.title).toBe("Method not found");
    expect(meta.alternates).toBeUndefined();
  });

  it("family, visible → real title + self-canonical", async () => {
    const meta = await familyMetadata({
      params: famParams("genomics-sequencing", "crispr-gene-editing-fam_1"),
    });
    expect(meta.title).toContain(FAM.familyLabel);
    expect(meta.alternates?.canonical).toBe(
      "/methods/genomics-sequencing/crispr-gene-editing-fam_1",
    );
  });
});
