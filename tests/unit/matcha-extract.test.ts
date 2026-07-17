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

import { extractMatchaConcepts } from "@/lib/api/matcha-extract";

/** Shape a mocked generateObject success — it returns `{ object }`. */
/** `kind` is optional here on purpose: the LLM's zod schema requires it, but
 *  `sanitizeConcepts` also cleans the dictionary-fallback path, which supplies none — so
 *  the tests must be able to hand it a concept with an absent or garbage kind. */
function objectWith(
  concepts: { term: string; kind?: string; centrality: number; gloss?: unknown }[],
) {
  return { object: { concepts } };
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedModelIds.length = 0;
  mockGenerateObject.mockResolvedValue(objectWith([]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("extractMatchaConcepts", () => {
  it("applies hygiene: clamp-high, non-finite/non-positive → 0.3 floor, trim, drop-empty, case-insensitive dedupe", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith([
        { term: "systemic sclerosis", kind: "concept", centrality: 1.0 },
        { term: "  Raynaud phenomenon ", kind: "concept", centrality: 0.5 }, // trimmed
        { term: "Systemic Sclerosis", kind: "concept", centrality: 0.9 }, // case-insensitive dup → dropped
        { term: "", kind: "concept", centrality: 0.4 }, // empty → dropped
        { term: "   ", kind: "concept", centrality: 0.4 }, // whitespace → dropped
        { term: "pulmonary fibrosis", kind: "concept", centrality: 1.4 }, // clamp high → 1
        { term: "vasculopathy", kind: "concept", centrality: -0.2 }, // non-positive → incidental floor 0.3
        { term: "background mention", kind: "concept", centrality: 0 }, // zero → incidental floor 0.3 (never 0 weight)
        { term: "infinite score", kind: "concept", centrality: Number.POSITIVE_INFINITY }, // non-finite → 0.3, NOT 1
        { term: "unscored concept", kind: "concept", centrality: Number.NaN }, // non-finite → 0.3
      ]),
    );

    const out = await extractMatchaConcepts("some sponsor prose");

    expect(out.concepts).toEqual([
      { term: "systemic sclerosis", kind: "concept", centrality: 1.0 },
      { term: "Raynaud phenomenon", kind: "concept", centrality: 0.5 },
      { term: "pulmonary fibrosis", kind: "concept", centrality: 1 },
      { term: "vasculopathy", kind: "concept", centrality: 0.3 },
      { term: "background mention", kind: "concept", centrality: 0.3 },
      { term: "infinite score", kind: "concept", centrality: 0.3 },
      { term: "unscored concept", kind: "concept", centrality: 0.3 },
    ]);
  });

  it("carries the LLM's kind through, and defaults an absent/garbage one to concept", async () => {
    // `kind` splits the rail's Concept and Method panels. The schema constrains the LLM to
    // the two values, but `sanitizeConcepts` also serves the dictionary fallback (which has
    // no LLM and supplies no kind) — so an absent kind must land on "concept", never
    // undefined, or the rail would drop the row from both panels.
    mockGenerateObject.mockResolvedValue(
      objectWith([
        { term: "CRISPR screening", kind: "method", centrality: 0.9 },
        { term: "systemic sclerosis", kind: "concept", centrality: 0.8 },
        { term: "no kind at all", centrality: 0.7 },
        { term: "garbage kind", kind: "wibble", centrality: 0.6 },
      ]),
    );

    const out = await extractMatchaConcepts("some sponsor prose");

    expect(out.concepts.map((c) => c.kind)).toEqual(["method", "concept", "concept", "concept"]);
  });

  it("carries a GLOSS through, cleaned — trims/collapses whitespace, drops a trailing period; omits absent/empty/over-long", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith([
        {
          term: "lysosomes",
          kind: "concept",
          centrality: 0.4,
          gloss: "  lysosomal processing of ADC\n linkers. ",
        },
        { term: "HER2-low breast cancer", kind: "concept", centrality: 1.0 }, // no gloss ⇒ key omitted
        { term: "systemic sclerosis", kind: "concept", centrality: 0.8, gloss: "   " }, // empty ⇒ omitted
        { term: "prose dump", kind: "concept", centrality: 0.3, gloss: "x".repeat(200) }, // over-long ⇒ omitted
      ]),
    );

    const out = await extractMatchaConcepts("some sponsor prose");

    // Absent stays absent (no `gloss` key), so a concept that stood alone never invents context.
    expect(out.concepts).toEqual([
      {
        term: "lysosomes",
        kind: "concept",
        centrality: 0.4,
        gloss: "lysosomal processing of ADC linkers",
      },
      { term: "HER2-low breast cancer", kind: "concept", centrality: 1.0 },
      { term: "systemic sclerosis", kind: "concept", centrality: 0.8 },
      { term: "prose dump", kind: "concept", centrality: 0.3 },
    ]);
  });

  it("caps the returned concepts at 12", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith(Array.from({ length: 15 }, (_, i) => ({ term: `concept-${i}`, centrality: 0.5 }))),
    );

    const out = await extractMatchaConcepts("a long call touching many topics");

    expect(out.concepts).toHaveLength(12);
    expect(out.concepts[0].term).toBe("concept-0"); // order preserved (most-central-first from the model)
  });

  it("sends a deterministic config — temperature 0, a schema, and a bounded output budget", async () => {
    mockGenerateObject.mockResolvedValue(objectWith([{ term: "cystic fibrosis", centrality: 1 }]));

    await extractMatchaConcepts("cystic fibrosis research");

    const args = mockGenerateObject.mock.calls[0][0];
    expect(args.temperature).toBe(0); // Sonnet accepts temperature (gate → true)
    expect(args.schema).toBeDefined();
    expect(typeof args.maxOutputTokens).toBe("number");
    expect(args.system).toContain("CENTRALITY");
  });

  it("defaults to the pinned Sonnet profile and honours the SPONSOR_MATCH_EXTRACT_MODEL override", async () => {
    mockGenerateObject.mockResolvedValue(objectWith([{ term: "cystic fibrosis", centrality: 1 }]));

    await extractMatchaConcepts("some sponsor prose");
    expect(capturedModelIds.at(-1)).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");

    const orig = process.env.SPONSOR_MATCH_EXTRACT_MODEL;
    process.env.SPONSOR_MATCH_EXTRACT_MODEL = "us.anthropic.claude-sonnet-4-6-v1:0";
    try {
      await extractMatchaConcepts("some sponsor prose");
      expect(capturedModelIds.at(-1)).toBe("us.anthropic.claude-sonnet-4-6-v1:0");
    } finally {
      if (orig === undefined) delete process.env.SPONSOR_MATCH_EXTRACT_MODEL;
      else process.env.SPONSOR_MATCH_EXTRACT_MODEL = orig;
    }
  });

  it("short-circuits an empty/whitespace paste WITHOUT calling the model", async () => {
    expect(await extractMatchaConcepts("")).toEqual({ concepts: [] });
    expect(await extractMatchaConcepts("   \n\t ")).toEqual({ concepts: [] });
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it("returns no concepts when Bedrock errors — never throws", async () => {
    mockGenerateObject.mockRejectedValue(new Error("bedrock 500"));
    await expect(extractMatchaConcepts("cancer immunotherapy")).resolves.toEqual({ concepts: [] });
  });

  it("returns no concepts when the model produces no valid object (unparseable output)", async () => {
    const err = new Error("no object generated");
    err.name = "AI_NoObjectGeneratedError";
    mockGenerateObject.mockRejectedValue(err);
    await expect(extractMatchaConcepts("cancer immunotherapy")).resolves.toEqual({ concepts: [] });
  });

  it("carries a titleSummary through, cleaned — trims, collapses whitespace, drops a trailing period", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        concepts: [{ term: "cystic fibrosis", kind: "concept", centrality: 1 }],
        titleSummary: "  Vertex —  gene editing\nfor cystic fibrosis.  ",
      },
    });

    const out = await extractMatchaConcepts("some sponsor prose");

    expect(out.titleSummary).toBe("Vertex — gene editing for cystic fibrosis");
  });

  it("drops a titleSummary that is absent or runs to prose (never becomes a header)", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        concepts: [{ term: "cystic fibrosis", kind: "concept", centrality: 1 }],
        titleSummary: "x".repeat(200), // over the length cap → rejected
      },
    });
    expect((await extractMatchaConcepts("prose")).titleSummary).toBeUndefined();

    mockGenerateObject.mockResolvedValue(objectWith([{ term: "cystic fibrosis", centrality: 1 }]));
    expect((await extractMatchaConcepts("prose")).titleSummary).toBeUndefined(); // omitted by model
  });
});
