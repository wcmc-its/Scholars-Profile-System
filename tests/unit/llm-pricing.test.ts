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

  it("returns null for an unrecognized model id", () => {
    expect(estimateDraftCostUsd("openai/gpt")).toBeNull();
  });
});
