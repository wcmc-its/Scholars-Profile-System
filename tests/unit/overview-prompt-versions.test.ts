/**
 * `lib/edit/overview-prompt-versions.ts` — the prompt-version registry (#742).
 * Covers the rollback lever (OVERVIEW_PROMPT_VERSION_DEFAULT), the validity guard,
 * the selectable list, the model humanizer, and (from the server module) the
 * effective-model precedence + the synopsis-finding permission the faithfulness
 * pass keys off. No DB, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defaultPromptVersionId,
  estimateDraftCostUsd,
  humanizeModelId,
  isValidPromptVersionId,
  listSelectablePromptVersions,
  OVERVIEW_DEFAULT_PROMPT_VERSION,
  OVERVIEW_PROMPT_VERSION_IDS,
} from "@/lib/edit/overview-prompt-versions";
import {
  resolveEffectiveOverviewModel,
  versionPermitsSynopsisFindings,
} from "@/lib/edit/overview-generator";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("defaultPromptVersionId — rollback lever (OVERVIEW_PROMPT_VERSION_DEFAULT)", () => {
  it("returns the registry default when the env is unset", () => {
    expect(defaultPromptVersionId()).toBe(OVERVIEW_DEFAULT_PROMPT_VERSION);
    expect(OVERVIEW_DEFAULT_PROMPT_VERSION).toBe("v4");
  });

  it("honors a VALID env override (the no-image-roll rollback to v2)", () => {
    vi.stubEnv("OVERVIEW_PROMPT_VERSION_DEFAULT", "v2");
    expect(defaultPromptVersionId()).toBe("v2");
  });

  it("falls back to the registry default for an INVALID env value", () => {
    vi.stubEnv("OVERVIEW_PROMPT_VERSION_DEFAULT", "v99");
    expect(defaultPromptVersionId()).toBe("v4");
  });
});

describe("isValidPromptVersionId", () => {
  it("accepts known ids, rejects everything else", () => {
    expect(isValidPromptVersionId("v2")).toBe(true);
    expect(isValidPromptVersionId("v3")).toBe(true);
    expect(isValidPromptVersionId("v1")).toBe(false);
    expect(isValidPromptVersionId(7)).toBe(false);
    expect(isValidPromptVersionId(undefined)).toBe(false);
  });
});

describe("listSelectablePromptVersions", () => {
  it("lists every registry version with display metadata, v4 first", () => {
    const list = listSelectablePromptVersions();
    expect(list.map((v) => v.id)).toEqual(OVERVIEW_PROMPT_VERSION_IDS);
    expect(list[0].id).toBe("v4");
    for (const v of list) {
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.description.length).toBeGreaterThan(0);
      expect(["default", "experimental", "deprecated"]).toContain(v.status);
    }
  });
});

describe("humanizeModelId", () => {
  it("humanizes the Anthropic Bedrock inference-profile ids", () => {
    expect(humanizeModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "Claude Sonnet 4.5",
    );
    expect(humanizeModelId("us.anthropic.claude-opus-4-8-20260101-v1:0")).toBe("Claude Opus 4.8");
    expect(humanizeModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Claude Haiku 4.5");
  });

  it("falls back to the raw id for an unrecognized model string", () => {
    expect(humanizeModelId("openai/gpt")).toBe("openai/gpt");
  });
});

describe("resolveEffectiveOverviewModel — precedence", () => {
  it("uses OVERVIEW_GENERATE_MODEL env over the default when no version pin", () => {
    vi.stubEnv("OVERVIEW_GENERATE_MODEL", "us.anthropic.claude-sonnet-4-6-test-v1:0");
    expect(resolveEffectiveOverviewModel("v3")).toBe("us.anthropic.claude-sonnet-4-6-test-v1:0");
  });

  it("falls back to the default Opus 4.8 model when nothing is set", () => {
    vi.stubEnv("OVERVIEW_GENERATE_MODEL", undefined);
    expect(resolveEffectiveOverviewModel("v3")).toContain("claude-opus-4-8");
  });
});

describe("versionPermitsSynopsisFindings — keeps the faithfulness pass in step with the floor", () => {
  it("is true for v4 (inherits v3's synopsis-finding permission)", () => {
    expect(versionPermitsSynopsisFindings("v4")).toBe(true);
  });

  it("is true for v3 (its floor permits a synopsis-reported finding)", () => {
    expect(versionPermitsSynopsisFindings("v3")).toBe(true);
  });

  it("is false for v2 (legacy: only publicationCount / yearsActive)", () => {
    expect(versionPermitsSynopsisFindings("v2")).toBe(false);
  });

  it("an unknown / missing version resolves to the default (v4 → true)", () => {
    expect(versionPermitsSynopsisFindings(undefined)).toBe(true);
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
