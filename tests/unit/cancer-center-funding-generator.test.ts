/**
 * NCI Table 2A judgment-column inference (`cancer-center-funding-generator.ts`):
 *  - happy path returns percent (clamped 0-100) + rationale;
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

import { inferCancerFundingJudgments } from "@/lib/edit/cancer-center-funding-generator";

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
  it("returns the percent (clamped) and rationale on the happy path", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 140 }));
    const result = await inferCancerFundingJudgments(INPUT);
    expect(result?.cancerRelevantPercent).toBe(100); // clamped, not passed through
    expect(result?.cancerRelevantRationale).toBe("because the title says so");
  });

  it("defaults to the pinned Sonnet extract model, honours the override lever", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 50 }));
    await inferCancerFundingJudgments(INPUT);
    expect(capturedModelIds[0]).toMatch(/sonnet/);

    process.env.CANCER_FUNDING_MODEL = "us.anthropic.claude-sonnet-9000";
    await inferCancerFundingJudgments(INPUT);
    expect(capturedModelIds[1]).toBe("us.anthropic.claude-sonnet-9000");
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
