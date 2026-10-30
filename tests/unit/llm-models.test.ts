/**
 * `lib/llm/models.ts` — Bedrock model defaults + request-shape gates. Pure; no network.
 * The gates decide what a 5.5 default vs. a 4.x env-var rollback is sent: a 5.x model
 * 400s on an explicit temperature, and Sonnet 4.5 400s on `output_config.effort`.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXTRACT_MODEL,
  DEFAULT_GENERATE_MODEL,
  bedrockCallOptions,
  modelAcceptsEffort,
  modelAcceptsTemperature,
  repairCurlyQuoteJson,
} from "@/lib/llm/models";

const OPUS_48 = "us.anthropic.claude-opus-4-8";
const SONNET_45 = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

describe("defaults", () => {
  it("are the 5.5 inference profiles", () => {
    expect(DEFAULT_GENERATE_MODEL).toBe("us.anthropic.claude-opus-5-5");
    expect(DEFAULT_EXTRACT_MODEL).toBe("us.anthropic.claude-sonnet-5-5");
  });
});

describe("modelAcceptsTemperature", () => {
  it("is false for Opus 4.7/4.8, every 5.x model, and Fable", () => {
    for (const id of [
      DEFAULT_GENERATE_MODEL,
      DEFAULT_EXTRACT_MODEL,
      "us.anthropic.claude-haiku-5-5",
      OPUS_48,
      "us.anthropic.claude-opus-4-7",
      "anthropic.claude-fable-5-1",
    ]) {
      expect(modelAcceptsTemperature(id), id).toBe(false);
    }
  });

  it("is true for the Sonnet 4.x rollback ids", () => {
    expect(modelAcceptsTemperature(SONNET_45)).toBe(true);
    expect(modelAcceptsTemperature("us.anthropic.claude-sonnet-4-6")).toBe(true);
  });

  it("reads dotted AI Gateway slugs the same way (lib/seo/llm-client.ts)", () => {
    expect(modelAcceptsTemperature("anthropic/claude-sonnet-5.5")).toBe(false);
    expect(modelAcceptsTemperature("anthropic/claude-opus-4.8")).toBe(false);
    expect(modelAcceptsTemperature("anthropic/claude-sonnet-4.5")).toBe(true);
    expect(modelAcceptsTemperature("openai/gpt-5.1")).toBe(true);
  });
});

describe("modelAcceptsEffort", () => {
  it("is true for the 5.5 defaults and Opus 4.8, false for Sonnet 4.5", () => {
    expect(modelAcceptsEffort(DEFAULT_GENERATE_MODEL)).toBe(true);
    expect(modelAcceptsEffort(DEFAULT_EXTRACT_MODEL)).toBe(true);
    expect(modelAcceptsEffort(OPUS_48)).toBe(true);
    expect(modelAcceptsEffort(SONNET_45)).toBe(false);
  });
});

describe("bedrockCallOptions", () => {
  it("sets effort on a model that accepts it", () => {
    expect(bedrockCallOptions(DEFAULT_GENERATE_MODEL, { effort: "high" })).toEqual({
      providerOptions: { bedrock: { reasoningConfig: { maxReasoningEffort: "high" } } },
    });
  });

  it("drops effort for a rollback id that would 400 on it", () => {
    expect(bedrockCallOptions(SONNET_45, { effort: "low" })).toEqual({});
  });

  it("sends nothing when no effort is asked for", () => {
    expect(bedrockCallOptions(DEFAULT_EXTRACT_MODEL, {})).toEqual({});
  });
});

describe("repairCurlyQuoteJson", () => {
  it("fixes a string closed with a curly quote (prod 2A failure, 10-29)", async () => {
    const text = '{"cancerRelevantPercent":50,"cancerRelevantRationale":"the PHR cites \\"brain and cancer samples\\".”}';
    expect(JSON.parse((await repairCurlyQuoteJson({ text }))!)).toEqual({
      cancerRelevantPercent: 50,
      cancerRelevantRationale: 'the PHR cites "brain and cancer samples".',
    });
  });

  it("returns null when the swap still doesn't parse", async () => {
    expect(await repairCurlyQuoteJson({ text: '{"a":"said “hi”, then"}' })).toBeNull();
  });
});
