import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  BIOSKETCH_PROMPT_IMPLS,
  BIOSKETCH_SYSTEM_PROMPT,
  BIOSKETCH_SYSTEM_PROMPT_V6,
  resolveBiosketchPromptImpl,
} from "@/lib/edit/biosketch-generator";
import {
  BIOSKETCH_DEFAULT_PROMPT_VERSION,
  BIOSKETCH_PROMPT_VERSION_IDS,
  biosketchVersionGroundsImpact,
  defaultBiosketchPromptVersionId,
  isValidBiosketchPromptVersionId,
  listSelectableBiosketchPromptVersions,
} from "@/lib/edit/biosketch-prompt-versions";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("biosketch prompt-version registry (#917 v6)", () => {
  it("default is v6, and the ids list it first (selector order)", () => {
    expect(BIOSKETCH_DEFAULT_PROMPT_VERSION).toBe("v6");
    expect(BIOSKETCH_PROMPT_VERSION_IDS[0]).toBe("v6");
    expect(BIOSKETCH_PROMPT_VERSION_IDS).toContain("v5");
  });

  it("isValid guards the union", () => {
    expect(isValidBiosketchPromptVersionId("v5")).toBe(true);
    expect(isValidBiosketchPromptVersionId("v6")).toBe(true);
    expect(isValidBiosketchPromptVersionId("v4")).toBe(false);
    expect(isValidBiosketchPromptVersionId(undefined)).toBe(false);
    expect(isValidBiosketchPromptVersionId(7)).toBe(false);
  });

  it("listSelectable returns the metas in insertion order (default first)", () => {
    const metas = listSelectableBiosketchPromptVersions();
    expect(metas.map((m) => m.id)).toEqual(["v6", "v5"]);
    expect(metas[0].status).toBe("default");
  });

  it("only v6 grounds impact on bibliometrics", () => {
    expect(biosketchVersionGroundsImpact("v6")).toBe(true);
    expect(biosketchVersionGroundsImpact("v5")).toBe(false);
  });

  describe("defaultBiosketchPromptVersionId — env lever", () => {
    const original = process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT;
    afterEach(() => {
      if (original === undefined) delete process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT;
      else process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT = original;
    });

    it("reads a valid env override (rollback lever)", () => {
      process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT = "v5";
      expect(defaultBiosketchPromptVersionId()).toBe("v5");
    });

    it("falls back to the compiled default on an invalid/unset value", () => {
      process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT = "nonsense";
      expect(defaultBiosketchPromptVersionId()).toBe("v6");
      delete process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT;
      expect(defaultBiosketchPromptVersionId()).toBe("v6");
    });
  });

  it("resolveBiosketchPromptImpl maps id → systemPrompt, falling back when invalid", () => {
    expect(resolveBiosketchPromptImpl("v5").id).toBe("v5");
    expect(resolveBiosketchPromptImpl("v5").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT);
    expect(resolveBiosketchPromptImpl("v6").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT_V6);
    // invalid → live default (v6 unless the env lever says otherwise)
    expect(resolveBiosketchPromptImpl("bogus").id).toBe("v6");
  });

  it("the impl map exposes exactly the two versions", () => {
    expect(Object.keys(BIOSKETCH_PROMPT_IMPLS).sort()).toEqual(["v5", "v6"]);
  });
});

describe("biosketch system prompts — byte-identity + v6 content", () => {
  it("v5 (BIOSKETCH_SYSTEM_PROMPT) is byte-identical — the baseline must not drift", () => {
    expect(sha(BIOSKETCH_SYSTEM_PROMPT)).toBe(
      "ec32440f49a4a08d597660e633b1989b04d7f19e5bad37372ae002ca07682bdb",
    );
  });

  it("v6 is a distinct prompt from v5", () => {
    expect(BIOSKETCH_SYSTEM_PROMPT_V6).not.toBe(BIOSKETCH_SYSTEM_PROMPT);
  });

  it("v6 carries the v6 directives and drops the banned register", () => {
    const v6 = BIOSKETCH_SYSTEM_PROMPT_V6;
    // first-person convention (§3-item-7): forbids "my laboratory"
    expect(v6).toContain('Do NOT');
    expect(v6.toLowerCase()).toContain("my laboratory");
    expect(v6.toLowerCase()).toContain('default to "i"');
    // four NIH elements (§3-item-6) + explicit role (§3-item-1)
    expect(v6).toContain("FOUR REQUIRED ELEMENTS");
    expect(v6).toContain("YOUR specific role");
    // grounded impact (§3-item-5)
    expect(v6).toContain("IMPACT, GROUNDED CONDITIONALLY");
    expect(v6).toContain("Relative Citation Ratio");
    // length band (§3-item-8)
    expect(v6).toContain("1,200 to 1,800");
    // em-dash ban (§2)
    expect(v6).toContain("Do not use em dashes or en dashes");
  });

  it("v6 reuses the shared entity-provenance floor", () => {
    // a distinctive line from ENTITY_PROVENANCE_FLOOR
    expect(BIOSKETCH_SYSTEM_PROMPT_V6).toContain("Use only what FACTS contains.");
  });
});
