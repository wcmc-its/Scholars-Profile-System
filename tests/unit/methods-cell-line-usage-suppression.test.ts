/**
 * #1502 — the family cell-line usage readers serve verbatim `usageSentence`
 * values baked from `pmid` by the tools ETL, whose sha256 short-circuit is blind
 * to Aurora-side ADR-005 takedowns. Both readers must drop darkened source pubs
 * at read time so a suppressed paper's sentence + link can't stay live between
 * artifact republishes. Mirrors the Prisma + lens-flag mock pattern in
 * `supercategory-family-entity-summaries.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockFindMany, mockEntityLayerOn, mockLoadSuppressions, mockResolveDark } = vi.hoisted(
  () => ({
    mockFindMany: vi.fn(),
    mockEntityLayerOn: vi.fn(),
    mockLoadSuppressions: vi.fn(),
    mockResolveDark: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: { familyEntityUsage: { findMany: mockFindMany } },
}));

vi.mock("@/lib/profile/methods-lens-flags", () => ({
  isMethodsLensEntityLayerOn: () => mockEntityLayerOn(),
}));

vi.mock("@/lib/api/manual-layer", () => ({
  loadPublicationSuppressions: (...a: unknown[]) => mockLoadSuppressions(...a),
  resolveDarkPmids: (...a: unknown[]) => mockResolveDark(...a),
}));

import {
  getFamilyCellLineUsageFacts,
  getFamilyCellLineRailPreviews,
} from "@/lib/api/methods";

const fact = (pmid: string, sentence: string, centralityScore = 0.5) => ({
  pmid,
  usageSentence: sentence,
  matchedSpanStart: null,
  matchedSpanEnd: null,
  centralityScore,
  mentionClass: null,
});
const preview = (normalizedEntityId: string, pmid: string, sentence: string) => ({
  normalizedEntityId,
  usageSentence: sentence,
  matchedSpanStart: null,
  matchedSpanEnd: null,
  pmid,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEntityLayerOn.mockReturnValue(true);
  mockLoadSuppressions.mockResolvedValue({ darkPmids: new Set(), hiddenAuthorsByPmid: new Map() });
  mockResolveDark.mockResolvedValue(new Set());
});

describe("getFamilyCellLineUsageFacts — #1502 read-time suppression", () => {
  it("drops facts whose source pmid is dark", async () => {
    mockFindMany.mockResolvedValue([fact("111", "clean"), fact("222", "SUPPRESSED")]);
    mockResolveDark.mockResolvedValue(new Set(["222"]));
    const facts = await getFamilyCellLineUsageFacts("sc", "F", "ent");
    expect(facts.map((f) => f.pmid)).toEqual(["111"]);
  });

  it("returns all facts when nothing is suppressed", async () => {
    mockFindMany.mockResolvedValue([fact("111", "a"), fact("222", "b")]);
    const facts = await getFamilyCellLineUsageFacts("sc", "F", "ent");
    expect(facts.map((f) => f.pmid)).toEqual(["111", "222"]);
  });

  it("returns [] without touching suppression when the entity layer is off", async () => {
    mockEntityLayerOn.mockReturnValue(false);
    const facts = await getFamilyCellLineUsageFacts("sc", "F", "ent");
    expect(facts).toEqual([]);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockResolveDark).not.toHaveBeenCalled();
  });
});

describe("getFamilyCellLineRailPreviews — #1502 read-time suppression", () => {
  it("skips a dark top-centrality row and falls to the clean fallback for the entity", async () => {
    // rows arrive centrality-desc; the top one is dark, so the clean second wins.
    mockFindMany.mockResolvedValue([
      preview("ent", "222", "dark top"),
      preview("ent", "111", "clean fallback"),
    ]);
    mockResolveDark.mockResolvedValue(new Set(["222"]));
    const previews = await getFamilyCellLineRailPreviews("sc", "F");
    expect(previews.ent).toMatchObject({ pmid: "111", sentence: "clean fallback" });
  });

  it("omits an entity entirely when its only source pub is dark", async () => {
    mockFindMany.mockResolvedValue([preview("ent", "222", "dark only")]);
    mockResolveDark.mockResolvedValue(new Set(["222"]));
    const previews = await getFamilyCellLineRailPreviews("sc", "F");
    expect(previews.ent).toBeUndefined();
  });
});
