/**
 * `lib/llm/pricing.ts` — display-only Bedrock cost estimation (#2123, moved out
 * of `lib/edit/overview-prompt-versions.ts`). No DB, no network.
 */
import { describe, expect, it } from "vitest";

import { estimateCostUsd, estimateDraftCostUsd } from "@/lib/llm/pricing";

describe("estimateCostUsd — prompt-cache aware (#2655)", () => {
  const OPUS = "us.anthropic.claude-opus-4-8";

  it("prices cache reads at 0.1× and cache writes at 1.25× the input rate", () => {
    // Opus $5/M in, $25/M out:
    //   1,000 uncached in       = 0.005
    //   10,000 cache read × 0.1 = 0.005
    //   4,000 cache write × 1.25= 0.025
    //   100 out                 = 0.0025
    expect(
      estimateCostUsd(OPUS, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 4000,
      }),
    ).toBeCloseTo(0.0375, 6);
  });

  it("a fully-cached prefix costs a tenth of re-sending it", () => {
    const uncached = estimateCostUsd(OPUS, { inputTokens: 10_000, outputTokens: 0 })!;
    const cached = estimateCostUsd(OPUS, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 10_000,
    })!;
    expect(cached).toBeCloseTo(uncached / 10, 9);
  });

  it("omitting the cache counts is the pre-#2655 arithmetic (the static console estimate)", () => {
    expect(estimateCostUsd(OPUS, { inputTokens: 5000, outputTokens: 300 })).toBeCloseTo(0.0325, 4);
  });

  it("still returns null for an unrecognized model id", () => {
    expect(
      estimateCostUsd("openai/gpt", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 }),
    ).toBeNull();
  });
});

describe("estimateDraftCostUsd — display-only superuser cost estimate", () => {
  it("returns ~$0.0325 for the Opus 4.8 inference profile", () => {
    expect(estimateDraftCostUsd("us.anthropic.claude-opus-4-8")).toBeCloseTo(0.0325, 4);
  });

  it("returns the cheaper Sonnet estimate", () => {
    // 5000/1e6 * 3 + 300/1e6 * 15 = 0.015 + 0.0045 = 0.0195
    expect(estimateDraftCostUsd("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBeCloseTo(
      0.0195,
      4,
    );
  });

  it("returns null for an unrecognized model id", () => {
    expect(estimateDraftCostUsd("openai/gpt")).toBeNull();
  });
});
