/**
 * NCI Table 2A judgment-column inference (`cancer-center-funding-generator.ts`):
 *  - happy path returns percent (clamped 0-100) + rationale, and — when a program
 *    list is given — a program code + rationale;
 *  - the program-code gate is UNCONDITIONAL: a model-returned code absent from the
 *    input `programs` list is dropped to null, never trusted, regardless of what
 *    the model said (the load-bearing "never invents a code" property);
 *  - no `programs` given (or `[]`) ⇒ `programCode`/`programRationale` are absent,
 *    not null — the caller didn't ask;
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

function objectWith(fields: {
  cancerRelevantPercent: number;
  cancerRelevantRationale?: string;
  programCode?: string | null;
  programRationale?: string | null;
}) {
  return {
    object: {
      cancerRelevantRationale: "because the title says so",
      programCode: null,
      programRationale: null,
      ...fields,
    },
  };
}

const INPUT = {
  projectTitle: "Triterpenoids as cancer chemopreventive agents",
  specificFundingSource: "National Cancer Institute",
  pi: "Alfred L",
};

const PROGRAMS = [
  { code: "CB", label: "Cancer Biology" },
  { code: "CGE", label: "Cancer Genetics & Epigenetics" },
];

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

  it("omits programCode/programRationale entirely when no program list was given", async () => {
    mockGenerateObject.mockResolvedValue(objectWith({ cancerRelevantPercent: 90 }));
    const result = await inferCancerFundingJudgments(INPUT);
    expect(result).not.toHaveProperty("programCode");
    expect(result).not.toHaveProperty("programRationale");
  });

  it("passes through a program code that IS in the given list", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith({ cancerRelevantPercent: 100, programCode: "CGE", programRationale: "genetics focus" }),
    );
    const result = await inferCancerFundingJudgments({ ...INPUT, programs: PROGRAMS });
    expect(result?.programCode).toBe("CGE");
    expect(result?.programRationale).toBe("genetics focus");
  });

  it("drops a program code NOT in the given list to null — never trusts an invented code", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith({ cancerRelevantPercent: 80, programCode: "MADE_UP_CODE" }),
    );
    const result = await inferCancerFundingJudgments({ ...INPUT, programs: PROGRAMS });
    expect(result?.programCode).toBeNull();
  });

  it("keeps an explicit null program code as null (no fit is a valid answer)", async () => {
    mockGenerateObject.mockResolvedValue(
      objectWith({ cancerRelevantPercent: 15, programCode: null, programRationale: "no listed program fits" }),
    );
    const result = await inferCancerFundingJudgments({ ...INPUT, programs: PROGRAMS });
    expect(result?.programCode).toBeNull();
    expect(result?.programRationale).toBe("no listed program fits");
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
