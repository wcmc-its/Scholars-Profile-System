/**
 * #917 follow-up A — `generateBiosketch` onProgress contract (`lib/edit/biosketch-generator.ts`).
 * The Bedrock calls (`ai`/bedrock) and the faithfulness grounder are mocked so the real generator
 * runs and we can assert: the ordered phase sequence (drafting → faithfulness done=0..N → products
 * → sources → done), the per-entry faithfulness tick (one per contribution as each grounds), that a
 * THROWING sink never breaks a generation, and that the result is identical with or without a sink.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGenerateText, mockGround } = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockGround: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: mockGenerateText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: () => () => ({}) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => undefined }));
vi.mock("@/lib/edit/overview-generator", () => ({
  DEFAULT_GENERATE_MODEL: "test-model",
  groundOverviewDraft: mockGround,
  modelAcceptsTemperature: () => false,
  toBiosketchModelFacts: (f: unknown) => f,
  toModelFacts: (f: unknown) => f,
}));
vi.mock("@/lib/edit/biosketch-products", () => ({
  // No products selected → the mapping gateway call is skipped (the `products` phase still fires).
  selectBiosketchProducts: () => ({ related: [], otherSignificant: [], relatedFromAims: false }),
  buildProductMappingPrompt: () => "",
  applyProductMapping: (s: unknown) => s,
  productPmids: () => [],
  PRODUCT_MAPPING_SYSTEM_PROMPT: "",
}));
vi.mock("@/lib/edit/biosketch-sources", () => ({
  buildSourceAttributionPrompt: () => "",
  parseSourceAttribution: () => [],
  SOURCE_ATTRIBUTION_SYSTEM_PROMPT: "",
}));

import { generateBiosketch, type BiosketchProgress } from "@/lib/edit/biosketch-generator";
import { normalizeBiosketchParams } from "@/lib/edit/biosketch-params";
import type { OverviewFacts } from "@/lib/edit/overview-facts";

// A v7 draft with two titled contributions, so the faithfulness pass runs twice.
const DRAFT = "1. TITLE: Alpha\n\nBody alpha.\n\n2. TITLE: Beta\n\nBody beta.";

const FACTS = {
  name: "Jane Smith",
  representativePublications: [{ pmid: "1" }],
} as unknown as OverviewFacts;

const PARAMS = normalizeBiosketchParams({ mode: "contributions", maxContributions: 5 });

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateText.mockResolvedValue({ text: DRAFT });
  // Pass-through grounder: echo the body back, strip nothing.
  mockGround.mockImplementation(async (_facts: unknown, prose: string) => ({
    prose,
    removed: [],
  }));
});

describe("generateBiosketch — onProgress", () => {
  it("fires the ordered phase sequence with a per-entry faithfulness tick", async () => {
    const events: BiosketchProgress[] = [];
    await generateBiosketch(FACTS, PARAMS, {
      faithfulnessPass: true,
      onProgress: (e) => events.push(e),
    });

    const phases = events.map((e) => e.phase);
    // drafting first, done last; products + sources fire (contributions, entries present, 1 pub).
    expect(phases[0]).toBe("drafting");
    expect(phases.at(-1)).toBe("done");
    expect(phases).toContain("products");
    expect(phases).toContain("sources");

    // Faithfulness: a done=0 priming tick then one per grounded contribution, ending at done=total.
    const faith = events.filter(
      (e): e is Extract<BiosketchProgress, { phase: "faithfulness" }> => e.phase === "faithfulness",
    );
    expect(faith.map((e) => e.done)).toEqual([0, 1, 2]);
    expect(faith.every((e) => e.total === 2)).toBe(true);

    // Overall ordering: drafting < every faithfulness < products < sources < done.
    expect(phases.indexOf("drafting")).toBeLessThan(phases.indexOf("faithfulness"));
    expect(phases.lastIndexOf("faithfulness")).toBeLessThan(phases.indexOf("products"));
    expect(phases.indexOf("products")).toBeLessThan(phases.indexOf("sources"));
    expect(phases.indexOf("sources")).toBeLessThan(phases.indexOf("done"));
  });

  it("a throwing sink never rejects the generation, and the result is sink-invariant", async () => {
    const clean = await generateBiosketch(FACTS, PARAMS, { faithfulnessPass: true });
    const withThrowingSink = await generateBiosketch(FACTS, PARAMS, {
      faithfulnessPass: true,
      onProgress: () => {
        throw new Error("sink blew up");
      },
    });
    // The progress sink is cosmetic: a throw is swallowed, and the result is byte-identical.
    expect(withThrowingSink).toEqual(clean);
    expect(clean.entries).toEqual([
      { title: "Alpha", body: "Body alpha." },
      { title: "Beta", body: "Body beta." },
    ]);
  });
});
