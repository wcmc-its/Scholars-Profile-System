/**
 * Phase 3 (TAXONOMY_SCHOLAR_CARDS) page wiring: flag off renders today's
 * `TopScholarsChipRow` (and does not turn on the rail adapters' scholar-names mode);
 * flag on renders `ScholarCardGrid` with the right chips, heading and
 * "View all" link, and turns the rail's scholar-names mode on.
 *   topic    → chips = top subareas, View all → /topics/<slug>/scholars
 *   family   → no chips, View all → the family scholars page
 *   category → chips = the scholar's families, no View all (no page exists)
 * Fake scholars only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  chipRow: vi.fn<(p: unknown) => null>(() => null),
  grid: vi.fn<(p: unknown) => null>(() => null),
  topicRail: vi.fn<(p: unknown) => null>(() => null),
  scRail: vi.fn<(p: unknown) => null>(() => null),
  fetchTopSubtopicsForScholars: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("__NOT_FOUND__");
  },
}));
vi.mock("@/components/topic/top-scholars-chip-row", () => ({ TopScholarsChipRow: h.chipRow }));
vi.mock("@/components/taxonomy/scholar-card-grid", () => ({
  ScholarCardGrid: h.grid,
  SCHOLAR_CARD_LIMIT: 6,
}));
vi.mock("@/components/topic/topic-rail-layout", () => ({ TopicRailLayout: h.topicRail }));
vi.mock("@/components/method/supercategory-rail-layout", () => ({
  SupercategoryRailLayout: h.scRail,
}));
vi.mock("@/components/method/family-publication-layout", () => ({
  FamilyPublicationLayout: () => null,
}));
vi.mock("@/components/method/family-entity-rail-layout", () => ({
  FamilyEntityRailLayout: () => null,
}));
vi.mock("@/components/shared/spotlight", () => ({ Spotlight: () => null }));
vi.mock("@/components/scholar-export/scholar-list-export-button", () => ({
  ScholarListExportButton: () => null,
}));
vi.mock("@/lib/export/scholar-export-flags", () => ({ isScholarListExportEnabled: () => false }));
vi.mock("@/lib/api/export-scholars", () => ({ isSupercategoryExportInRange: async () => false }));
vi.mock("@/lib/api/spotlight", () => ({
  getSpotlightCardsForTopic: async () => null,
  TOPIC_SPOTLIGHT_POOL_MAX: 9,
}));
vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodPagesEnabled: () => true,
  isMethodsFamilyDefinitionsOn: () => false,
}));

const top = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    cwid: `aaa${1000 + i}`,
    slug: `test-person-${i}`,
    preferredName: `Test Person ${i}`,
    primaryTitle: null,
    identityImageEndpoint: "",
    rank: i + 1,
  }));

vi.mock("@/lib/api/topics", () => ({
  getTopic: async () => ({ id: "cardio", label: "Cardio", description: null }),
  getTopScholarsForTopic: async () => top(7),
  getSubtopicsForTopic: async () => [],
  getDistinctScholarCountForTopic: async () => 42,
  fetchTopSubtopicsForScholars: h.fetchTopSubtopicsForScholars,
}));

vi.mock("@/lib/api/methods", () => ({
  getSupercategory: async () => ({
    id: "imaging_x",
    slug: "imaging-x",
    label: "Imaging",
    description: "",
  }),
  getSupercategoryRollup: async () => ({
    families: [
      {
        familyId: "fam_0001",
        familyLabel: "MRI",
        familySlug: "mri-fam_0001",
        scholarCount: 3,
        pubCount: 9,
        exemplarTools: [],
        definition: null,
        definitionSource: null,
      },
    ],
    allWorkPubs: [],
  }),
  getTopScholarsForSupercategory: async () =>
    top(7).map((s, i) => ({ ...s, families: i === 0 ? ["MRI", "PET"] : [] })),
  getSupercategoryFamilyEntitySummaries: async () => ({}),
  getFamily: async () => ({
    supercategory: "imaging_x",
    supercategorySlug: "imaging-x",
    familyId: "fam_0001",
    familyLabel: "MRI",
    familySlug: "mri-fam_0001",
    definition: null,
    definitionSource: null,
  }),
  getFamilyScholars: async () => top(7),
  getDistinctScholarCountForFamily: async () => 12,
  getRepresentativePubsForFamily: async () => [],
  getFamilyCellLineEntities: async () => [],
  getDistinctPmidCountForFamily: async () => 0,
}));

import TopicPage from "@/app/(public)/topics/[slug]/page";
import SupercategoryPage from "@/app/(public)/methods/[supercategory]/page";
import FamilyPage from "@/app/(public)/methods/[supercategory]/[family]/page";

type GridProps = {
  heading: string;
  scholars: Array<{ cwid: string; areas: string[] }>;
  viewAll?: { href: string; count: number } | null;
};
const gridProps = () => h.grid.mock.calls[0][0] as GridProps;

async function renderTopic() {
  render(await TopicPage({ params: Promise.resolve({ slug: "cardio" }) }));
}
async function renderCategory() {
  render(await SupercategoryPage({ params: Promise.resolve({ supercategory: "imaging-x" }) }));
}
async function renderFamily() {
  render(
    await FamilyPage({
      params: Promise.resolve({ supercategory: "imaging-x", family: "mri-fam_0001" }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fetchTopSubtopicsForScholars.mockResolvedValue(
    new Map([
      [
        "aaa1000",
        [
          { id: "s1", displayName: "Arrhythmia" },
          { id: "s2", displayName: "Heart failure" },
        ],
      ],
    ]),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("flag off (today's behavior)", () => {
  it.each([
    ["topic", renderTopic],
    ["category", renderCategory],
    ["family", renderFamily],
  ])("%s page renders TopScholarsChipRow, not the card grid", async (_k, run) => {
    await run();
    expect(h.chipRow).toHaveBeenCalledTimes(1);
    expect(h.grid).not.toHaveBeenCalled();
    expect(h.fetchTopSubtopicsForScholars).not.toHaveBeenCalled();
  });

  it("rail adapters get no scholar-names mode", async () => {
    await renderTopic();
    await renderCategory();
    expect((h.topicRail.mock.calls[0][0] as { scholarNames: boolean }).scholarNames).toBe(false);
    expect((h.scRail.mock.calls[0][0] as { scholarNames: boolean }).scholarNames).toBe(false);
  });
});

describe("flag on", () => {
  beforeEach(() => vi.stubEnv("TAXONOMY_SCHOLAR_CARDS", "on"));

  it("topic: top 6 cards with subarea chips + View all → topic scholars page", async () => {
    await renderTopic();
    expect(h.chipRow).not.toHaveBeenCalled();
    const p = gridProps();
    expect(p.heading).toBe("Scholars in this area");
    expect(p.scholars).toHaveLength(6);
    expect(p.scholars[0].areas).toEqual(["Arrhythmia", "Heart failure"]);
    expect(p.scholars[1].areas).toEqual([]);
    expect(p.viewAll).toEqual({ href: "/topics/cardio/scholars", count: 42 });
    // Subareas are fetched for the 6 shown scholars only.
    expect(h.fetchTopSubtopicsForScholars).toHaveBeenCalledWith(
      "cardio",
      top(6).map((s) => s.cwid),
    );
    expect((h.topicRail.mock.calls[0][0] as { scholarNames: boolean }).scholarNames).toBe(true);
  });

  it("category: family chips and NO View all link", async () => {
    await renderCategory();
    const p = gridProps();
    expect(p.heading).toBe("Scholars using this");
    expect(p.scholars[0].areas).toEqual(["MRI", "PET"]);
    expect(p.viewAll).toBeUndefined();
    expect((h.scRail.mock.calls[0][0] as { scholarNames: boolean }).scholarNames).toBe(true);
  });

  it("family: no chips, View all → the family scholars page", async () => {
    await renderFamily();
    const p = gridProps();
    expect(p.heading).toBe("Scholars using this");
    expect(p.scholars.every((s) => s.areas.length === 0)).toBe(true);
    expect(p.viewAll).toEqual({ href: "/methods/imaging-x/mri-fam_0001/scholars", count: 12 });
  });
});
