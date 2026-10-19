/**
 * NCI Table 2A judgment-column inference (`cancer-center-funding-generator.ts`):
 *  - happy path returns a band percent + rationale + provenance (model id,
 *    stable prompt hash, an input hash that moves with the inputs);
 *  - an off-band percent (e.g. 37) returns `null`, never a rounded value;
 *  - the model id defaults to the pinned Sonnet profile and honours the
 *    `CANCER_FUNDING_MODEL` override lever;
 *  - a Bedrock error, OR a non-finite percent, returns `null` — NEVER throws, so a
 *    batch import can carry on to the next row.
 * Mocks `ai` (generateObject), the Bedrock provider, and the credential chain —
 * NEVER invokes Bedrock or AWS.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGenerateObject, capturedModelIds } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
  capturedModelIds: [] as string[],
}));

vi.mock("ai", () => ({ generateObject: mockGenerateObject }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => (modelId: string) => {
    capturedModelIds.push(modelId);
    return {};
  },
}));
vi.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => () => ({}),
}));

import {
  CANCER_FUNDING_PROMPT_HASH,
  inferCancerFundingJudgments,
} from "@/lib/edit/cancer-center-funding-generator";

function objectWith(fields: { cancerRelevantPercent: number; cancerRelevantRationale?: string }) {
  return {
    object: {
      cancerRelevantRationale: "because the title says so",
      ...fields,
    },
  };
}

const INPUT = {
  projectTitle: "Triterpenoids as cancer chemopreventive agents",
  specificFundingSource: "National Cancer Institute",
  pi: "Alfred L",
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedModelIds.length = 0;
  delete process.env.CANCER_FUNDING_MODEL;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("inferCancerFundingJudgments", () => {
  it("returns the band, rationale and provenance on the happy path", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 50 }));
    const result = await inferCancerFundingJudgments(INPUT);
    expect(result?.cancerRelevantPercent).toBe(50);
    expect(result?.cancerRelevantRationale).toBe("because the title says so");
    expect(result?.cancerRelevantModel).toBe(capturedModelIds[0]);
    expect(result?.cancerRelevantPromptHash).toBe(CANCER_FUNDING_PROMPT_HASH);
    expect(CANCER_FUNDING_PROMPT_HASH).toMatch(/^[0-9a-f]{12}$/);
    expect(result?.cancerRelevantInputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result?.cancerRelevantInferredAt).toBeInstanceOf(Date);
  });

  it("returns null for an off-band percent rather than rounding it to a band", async () => {
    for (const pct of [37, 140, 10]) {
      mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: pct }));
      expect(await inferCancerFundingJudgments(INPUT)).toBeNull();
    }
  });

  it("sends the abstract and PHR, and the input hash moves with the inputs", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 100 }));
    const plain = await inferCancerFundingJudgments(INPUT);
    const again = await inferCancerFundingJudgments(INPUT);
    const withText = await inferCancerFundingJudgments({
      ...INPUT,
      abstract: "HPV-driven oropharyngeal tumors.",
      phrText: "Reduces HPV-related cancer.",
    });
    const prompt = mockGenerateObject.mock.calls[2][0].prompt as string;
    expect(prompt).toContain("Abstract: HPV-driven oropharyngeal tumors.");
    expect(prompt).toContain("Public Health Relevance: Reduces HPV-related cancer.");
    expect(again?.cancerRelevantInputHash).toBe(plain?.cancerRelevantInputHash);
    expect(withText?.cancerRelevantInputHash).not.toBe(plain?.cancerRelevantInputHash);
    expect(withText?.cancerRelevantPromptHash).toBe(plain?.cancerRelevantPromptHash);
  });

  it("defaults to the pinned Sonnet extract model, honours the override lever", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 50 }));
    await inferCancerFundingJudgments(INPUT);
    expect(capturedModelIds[0]).toMatch(/sonnet/);

    process.env.CANCER_FUNDING_MODEL = "us.anthropic.claude-sonnet-9000";
    const result = await inferCancerFundingJudgments(INPUT);
    expect(capturedModelIds[1]).toBe("us.anthropic.claude-sonnet-9000");
    expect(result?.cancerRelevantModel).toBe("us.anthropic.claude-sonnet-9000");
  });

  it("returns null (never throws) on a Bedrock error", async () => {
    mockGenerateObject.mockRejectedValue(new Error("bedrock timeout"));
    const result = await inferCancerFundingJudgments(INPUT);
    expect(result).toBeNull();
  });

  it("returns null on a non-finite percent rather than storing a wrong number", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: NaN }));
    const result = await inferCancerFundingJudgments(INPUT);
    expect(result).toBeNull();
  });
});
