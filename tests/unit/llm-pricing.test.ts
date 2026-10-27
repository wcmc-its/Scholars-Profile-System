/**
 * `lib/llm/pricing.ts` — display-only Bedrock cost estimation (#2123, moved out
 * of `lib/edit/overview-prompt-versions.ts`). No DB, no network.
 */
import { describe, expect, it } from "vitest";

import { estimateDraftCostUsd } from "@/lib/llm/pricing";

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

  it("prices the 5.5 generation separately from the 4.x ids", () => {
    // Opus 5.5: 5000/1e6 * 4 + 300/1e6 * 20 = 0.02 + 0.006 = 0.026
    expect(estimateDraftCostUsd("us.anthropic.claude-opus-5-5")).toBeCloseTo(0.026, 4);
    // Sonnet 5.5: 5000/1e6 * 2 + 300/1e6 * 10 = 0.01 + 0.003 = 0.013
    expect(estimateDraftCostUsd("us.anthropic.claude-sonnet-5-5")).toBeCloseTo(0.013, 4);
    // Haiku 5.5: 5000/1e6 * 0.1 + 300/1e6 * 0.5 = 0.0005 + 0.00015 = 0.00065
    expect(estimateDraftCostUsd("us.anthropic.claude-haiku-5-5")).toBeCloseTo(0.00065, 6);
  });

  it("returns null for an unrecognized model id", () => {
    expect(estimateDraftCostUsd("openai/gpt")).toBeNull();
  });
});
