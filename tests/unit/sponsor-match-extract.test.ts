/**
 * Sponsor-match Bedrock concept extractor (`sponsor-match-extract.ts`):
 *  - happy path returns the model's concepts with hygiene applied — centrality >1
 *    clamped to 1, a non-finite (NaN/±Infinity) OR non-positive score floored to the
 *    incidental 0.3, terms trimmed, empty/whitespace terms dropped, case-insensitive
 *    dedupe (first wins), capped at 12;
 *  - the model id defaults to the pinned Sonnet profile and honours the
 *    `SPONSOR_MATCH_EXTRACT_MODEL` override (runtime rollback lever);
 *  - a deterministic config reaches the call (temperature 0 on the Sonnet profile,
 *    which accepts it; a structured schema; a bounded output budget);
 *  - an empty/whitespace paste short-circuits WITHOUT calling the model;
 *  - a Bedrock error OR an unparseable (no-object) result returns [] — NEVER throws,
 *    so the spine can fall back to the dictionary extractor.
 * Mocks `ai` (generateObject), the Bedrock provider, and the credential chain — NEVER
 * invokes Bedrock or AWS; also stubs `overview-generator` so only `modelAcceptsTemperature`
 * is pulled in, not its dependency graph.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateObject, capturedModelIds } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  capturedModelIds: [] as string[],
}));

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
// The provider + credential chain are constructed but never exercised (generateObject
// is mocked) — dummy them so nothing reaches AWS at construction time. The model-id
// factory records its argument so the default/override lever is observable.
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => (modelId: string) => {
    capturedModelIds.push(modelId);
    return {};
  },
}));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => () => ({}),
}));
// Reuse the real temperature gate's semantics without importing the heavy
// overview-generator graph (@/lib/db, prompt modules, …).
vi.mock("@/lib/edit/overview-generator", () => ({
  modelAcceptsTemperature: (id: string) => !/claude-(opus-4-[78]|fable)/.test(id),
}));

import { extractSponsorConcepts } from "@/lib/api/sponsor-match-extract";

/** Shape a mocked generateObject success — it returns `{ object }`. */
function objectWith(concepts: { term: string; centrality: number }[]) {
  return { object: { concepts } };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedModelIds.length = 0;
  mockGenerateObject.mockResolvedValue(objectWith([]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("extractSponsorConcepts", () => {
  it("applies hygiene: clamp-high, non-finite/non-positive → 0.3 floor, trim, drop-empty, case-insensitive dedupe", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith([
        { term: "systemic sclerosis", centrality: 1.0 },
        { term: "  Raynaud phenomenon ", centrality: 0.5 }, // trimmed
        { term: "Systemic Sclerosis", centrality: 0.9 }, // case-insensitive dup → dropped
        { term: "", centrality: 0.4 }, // empty → dropped
        { term: "   ", centrality: 0.4 }, // whitespace → dropped
        { term: "pulmonary fibrosis", centrality: 1.4 }, // clamp high → 1
        { term: "vasculopathy", centrality: -0.2 }, // non-positive → incidental floor 0.3
        { term: "background mention", centrality: 0 }, // zero → incidental floor 0.3 (never 0 weight)
        { term: "infinite score", centrality: Number.POSITIVE_INFINITY }, // non-finite → 0.3, NOT 1
        { term: "unscored concept", centrality: Number.NaN }, // non-finite → 0.3
      ]),
    );

    const out = await extractSponsorConcepts("some sponsor prose");

    expect(out).toEqual([
      { term: "systemic sclerosis", centrality: 1.0 },
      { term: "Raynaud phenomenon", centrality: 0.5 },
      { term: "pulmonary fibrosis", centrality: 1 },
      { term: "vasculopathy", centrality: 0.3 },
      { term: "background mention", centrality: 0.3 },
      { term: "infinite score", centrality: 0.3 },
      { term: "unscored concept", centrality: 0.3 },
    ]);
  });

  it("caps the returned concepts at 12", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith(Array.from({ length: 15 }, (_, i) => ({ term: `concept-${i}`, centrality: 0.5 }))),
    );

    const out = await extractSponsorConcepts("a long call touching many topics");

    expect(out).toHaveLength(12);
    expect(out[0].term).toBe("concept-0"); // order preserved (most-central-first from the model)
  });

  it("sends a deterministic config — temperature 0, a schema, and a bounded output budget", async () => {
    mockGenerateObject.mockResolvedValue(objectWith([{ term: "cystic fibrosis", centrality: 1 }]));

    await extractSponsorConcepts("cystic fibrosis research");

    const args = mockGenerateObject.mock.calls[0][0];
    expect(args.temperature).toBe(0); // Sonnet accepts temperature (gate → true)
    expect(args.schema).toBeDefined();
    expect(typeof args.maxOutputTokens).toBe("number");
    expect(args.system).toContain("CENTRALITY");
  });

  it("defaults to the pinned Sonnet profile and honours the SPONSOR_MATCH_EXTRACT_MODEL override", async () => {
    mockGenerateObject.mockResolvedValue(objectWith([{ term: "cystic fibrosis", centrality: 1 }]));

    await extractSponsorConcepts("some sponsor prose");
    expect(capturedModelIds.at(-1)).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");

    const orig = process.env.SPONSOR_MATCH_EXTRACT_MODEL;
    process.env.SPONSOR_MATCH_EXTRACT_MODEL = "us.anthropic.claude-sonnet-4-6-v1:0";
    try {
      await extractSponsorConcepts("some sponsor prose");
      expect(capturedModelIds.at(-1)).toBe("us.anthropic.claude-sonnet-4-6-v1:0");
    } finally {
      if (orig === undefined) delete process.env.SPONSOR_MATCH_EXTRACT_MODEL;
      else process.env.SPONSOR_MATCH_EXTRACT_MODEL = orig;
    }
  });

  it("short-circuits an empty/whitespace paste WITHOUT calling the model", async () => {
    expect(await extractSponsorConcepts("")).toEqual([]);
    expect(await extractSponsorConcepts("   \n\t ")).toEqual([]);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("returns [] when Bedrock errors — never throws", async () => {
    mockGenerateObject.mockRejectedValue(new Error("bedrock 500"));
    await expect(extractSponsorConcepts("cancer immunotherapy")).resolves.toEqual([]);
  });

  it("returns [] when the model produces no valid object (unparseable output)", async () => {
    const err = new Error("no object generated");
    err.name = "AI_NoObjectGeneratedError";
    mockGenerateObject.mockRejectedValue(err);
    await expect(extractSponsorConcepts("cancer immunotherapy")).resolves.toEqual([]);
  });
});
