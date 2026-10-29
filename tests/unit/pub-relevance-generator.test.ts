/**
 * Publication cancer relevance (`lib/edit/pub-relevance-generator.ts`):
 *  - the publication-type rule: MCC's never-counted types get a fixed reason
 *    and no model call; every other type (and none), a review included, goes
 *    to the model;
 *  - the ETL's re-decide test: a review's old rule row is redone, a human row
 *    never is;
 *  - the output parser: adds a missing opening, rejects one that contradicts
 *    the answer, rejects an empty reason;
 *  - provenance: prompt hash on an AI row, none on a rule row, an input hash
 *    that moves with the inputs;
 *  - a Bedrock error returns null, never throws.
 * Mocks `ai` and the Bedrock provider — NEVER invokes Bedrock or AWS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateObject } = vi.hoisted(() => ({ mockGenerateObject: vi.fn() }));

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: () => () => ({}) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain: () => () => ({}) }));

import {
  inferPubRelevance,
  parsePubRelevanceOutput,
  PUB_RELEVANCE_PROMPT_HASH,
  PUB_RELEVANCE_RULE_MODEL,
  publicationTypeRule,
  pubRelevanceInputHash,
  pubRelevanceNeedsDecision,
} from "@/lib/edit/pub-relevance-generator";

const INPUT = {
  title: "A synthetic study of tumor growth in a mouse model",
  abstract: "We studied tumors.",
  meshTerms: ["Neoplasms", "Mice"],
  publicationType: "Academic Article",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("publicationTypeRule", () => {
  it.each([
    ["Preprint", "This is not cancer relevant. This is a preprint."],
    ["Erratum", "This is not cancer relevant. This is a published erratum."],
    ["Letter", "This is not cancer relevant. This is a letter."],
    ["Comment", "This is not cancer relevant. This is a comment."],
    ["Editorial Article", "This is not cancer relevant. This is an editorial."],
    ["Retraction", "This is not cancer relevant. This is a retraction."],
  ])("%s is decided by rule", (type, reason) => {
    expect(publicationTypeRule(type)).toBe(reason);
  });

  it.each([
    "Academic Article",
    "Review",
    "Article",
    "Case Report",
    "Guideline",
    "Conference Paper",
    "review",
    "",
    null,
    undefined,
  ])("%j goes to the model", (type) => {
    expect(publicationTypeRule(type)).toBeNull();
  });
});

describe("pubRelevanceNeedsDecision", () => {
  const REVIEW = { ...INPUT, publicationType: "Review" };
  const hash = pubRelevanceInputHash(REVIEW);

  it("decides a publication with no row", () => {
    expect(pubRelevanceNeedsDecision(undefined, REVIEW)).toBe(true);
  });

  it("redoes a review's rule row from the retired review rule, though its inputs did not change", () => {
    expect(pubRelevanceNeedsDecision({ source: "rule", inputHash: hash }, REVIEW)).toBe(true);
  });

  it("keeps a current rule row, and an llm row whose inputs did not change", () => {
    const PRE = { ...INPUT, publicationType: "Preprint" };
    expect(
      pubRelevanceNeedsDecision({ source: "rule", inputHash: pubRelevanceInputHash(PRE) }, PRE),
    ).toBe(false);
    expect(pubRelevanceNeedsDecision({ source: "llm", inputHash: hash }, REVIEW)).toBe(false);
  });

  it("redoes an llm row whose inputs changed", () => {
    expect(pubRelevanceNeedsDecision({ source: "llm", inputHash: "stale" }, REVIEW)).toBe(true);
  });

  it("never touches a reviewer's row, a review's included", () => {
    expect(pubRelevanceNeedsDecision({ source: "human", inputHash: "stale" }, REVIEW)).toBe(false);
    expect(pubRelevanceNeedsDecision({ source: "human", inputHash: null }, INPUT)).toBe(false);
  });
});

describe("parsePubRelevanceOutput", () => {
  it("keeps a reason that opens with the matching sentence", () => {
    expect(
      parsePubRelevanceOutput({
        relevant: true,
        reason: " This is cancer relevant. It studies  melanoma. ",
      }),
    ).toEqual({
      relevant: true,
      reason: "This is cancer relevant. It studies melanoma.",
    });
  });

  it("adds the opening when the model left it out", () => {
    expect(
      parsePubRelevanceOutput({ relevant: false, reason: "The focus is liver fibrosis." }),
    ).toEqual({
      relevant: false,
      reason: "This is not cancer relevant. The focus is liver fibrosis.",
    });
  });

  it("rejects a reason that contradicts the answer", () => {
    expect(
      parsePubRelevanceOutput({ relevant: true, reason: "This is not cancer relevant. Diabetes." }),
    ).toBeNull();
    expect(
      parsePubRelevanceOutput({ relevant: false, reason: "This is cancer relevant. Leukemia." }),
    ).toBeNull();
  });

  it("rejects an empty reason, or the opening alone", () => {
    expect(parsePubRelevanceOutput({ relevant: true, reason: "   " })).toBeNull();
    expect(
      parsePubRelevanceOutput({ relevant: false, reason: "This is not cancer relevant." }),
    ).toBeNull();
  });

  it("caps the reason at 500 characters", () => {
    const out = parsePubRelevanceOutput({
      relevant: true,
      reason: `This is cancer relevant. ${"x".repeat(900)}`,
    });
    expect(out?.reason).toHaveLength(500);
  });
});

describe("inferPubRelevance", () => {
  it("decides a rule type with no model call", async () => {
    const r = await inferPubRelevance({ ...INPUT, publicationType: "Preprint" });
    expect(mockGenerateObject).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      relevant: false,
      source: "rule",
      model: PUB_RELEVANCE_RULE_MODEL,
      promptHash: null,
      reason: "This is not cancer relevant. This is a preprint.",
    });
    expect(r?.inputHash).toBe(pubRelevanceInputHash({ ...INPUT, publicationType: "Preprint" }));
  });

  it("sends a review to the model, not the rule, and the prompt judges reviews on topic", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { relevant: true, reason: "This is cancer relevant. It reviews melanoma therapy." },
    });
    const r = await inferPubRelevance({ ...INPUT, publicationType: "Review" });
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ relevant: true, source: "llm" });
    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain("Publication type: Review");
    expect(call.system).toContain("Judge a review");
  });

  it("returns the model's answer with provenance", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { relevant: true, reason: "This is cancer relevant. Tumor growth." },
    });
    const r = await inferPubRelevance(INPUT);
    expect(r).toMatchObject({
      relevant: true,
      source: "llm",
      reason: "This is cancer relevant. Tumor growth.",
      promptHash: PUB_RELEVANCE_PROMPT_HASH,
      inputHash: pubRelevanceInputHash(INPUT),
    });
    expect(r?.model).toMatch(/sonnet/);
    const prompt = mockGenerateObject.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Abstract: We studied tumors.");
    expect(prompt).toContain("MeSH terms: Neoplasms; Mice");
  });

  it("moves the input hash when an input changes", () => {
    expect(pubRelevanceInputHash(INPUT)).not.toBe(
      pubRelevanceInputHash({ ...INPUT, abstract: "Changed." }),
    );
    expect(pubRelevanceInputHash(INPUT)).toBe(pubRelevanceInputHash({ ...INPUT }));
  });

  it("returns null, never throws, on a Bedrock error or an unusable answer", async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error("throttled"));
    await expect(inferPubRelevance(INPUT)).resolves.toBeNull();
    mockGenerateObject.mockResolvedValueOnce({
      object: { relevant: true, reason: "This is not cancer relevant." },
    });
    await expect(inferPubRelevance(INPUT)).resolves.toBeNull();
  });
});
