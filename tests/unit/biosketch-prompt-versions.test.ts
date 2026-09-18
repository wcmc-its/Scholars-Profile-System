import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  BIOSKETCH_PROMPT_IMPLS,
  BIOSKETCH_SYSTEM_PROMPT,
  BIOSKETCH_SYSTEM_PROMPT_V6,
  BIOSKETCH_SYSTEM_PROMPT_V7,
  BIOSKETCH_SYSTEM_PROMPT_V8,
  resolveBiosketchPromptImpl,
} from "@/lib/edit/biosketch-generator";
import {
  BIOSKETCH_DEFAULT_PROMPT_VERSION,
  BIOSKETCH_PROMPT_VERSION_IDS,
  biosketchVersionEmitsTitle,
  biosketchVersionGroundsImpact,
  biosketchVersionUsesApplicationRole,
  biosketchVersionUsesProductReferences,
  defaultBiosketchPromptVersionId,
  isValidBiosketchPromptVersionId,
  listSelectableBiosketchPromptVersions,
} from "@/lib/edit/biosketch-prompt-versions";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("biosketch prompt-version registry (#917 v6)", () => {
  it("default is v7, and the ids list it first (selector order)", () => {
    expect(BIOSKETCH_DEFAULT_PROMPT_VERSION).toBe("v7");
    expect(BIOSKETCH_PROMPT_VERSION_IDS[0]).toBe("v7");
    expect(BIOSKETCH_PROMPT_VERSION_IDS).toContain("v6");
    expect(BIOSKETCH_PROMPT_VERSION_IDS).toContain("v5");
  });

  it("isValid guards the union", () => {
    expect(isValidBiosketchPromptVersionId("v5")).toBe(true);
    expect(isValidBiosketchPromptVersionId("v6")).toBe(true);
    expect(isValidBiosketchPromptVersionId("v7")).toBe(true);
    expect(isValidBiosketchPromptVersionId("v4")).toBe(false);
    expect(isValidBiosketchPromptVersionId(undefined)).toBe(false);
    expect(isValidBiosketchPromptVersionId(8)).toBe(false);
  });

  it("listSelectable returns the metas in insertion order (default first)", () => {
    const metas = listSelectableBiosketchPromptVersions();
    // #2653 — v8 sits behind the v7 default as the experimental candidate; v7 is the rollback.
    expect(metas.map((m) => m.id)).toEqual(["v7", "v8", "v6", "v5"]);
    expect(metas[0].status).toBe("default");
    expect(metas[1].status).toBe("experimental");
  });

  it("v6 and v7 ground impact on bibliometrics; v5 does not", () => {
    expect(biosketchVersionGroundsImpact("v7")).toBe(true);
    expect(biosketchVersionGroundsImpact("v6")).toBe(true);
    expect(biosketchVersionGroundsImpact("v5")).toBe(false);
  });

  it("v7 and v8 emit a per-contribution title; v5 / v6 do not", () => {
    expect(biosketchVersionEmitsTitle("v8")).toBe(true);
    expect(biosketchVersionEmitsTitle("v7")).toBe(true);
    expect(biosketchVersionEmitsTitle("v6")).toBe(false);
    expect(biosketchVersionEmitsTitle("v5")).toBe(false);
  });

  it("only v8 takes the role on the application and permits product references (#2653)", () => {
    expect(biosketchVersionUsesApplicationRole("v8")).toBe(true);
    expect(biosketchVersionUsesProductReferences("v8")).toBe(true);
    for (const id of ["v5", "v6", "v7"] as const) {
      expect(biosketchVersionUsesApplicationRole(id)).toBe(false);
      expect(biosketchVersionUsesProductReferences(id)).toBe(false);
    }
    expect(isValidBiosketchPromptVersionId("v8")).toBe(true);
    // v8 is selectable + a valid env-lever target, but NOT the compiled default (gate first).
    expect(BIOSKETCH_DEFAULT_PROMPT_VERSION).toBe("v7");
    expect(resolveBiosketchPromptImpl("v8").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT_V8);
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
      expect(defaultBiosketchPromptVersionId()).toBe("v7");
      delete process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT;
      expect(defaultBiosketchPromptVersionId()).toBe("v7");
    });

    it("v6 stays a valid rollback target for the env lever", () => {
      process.env.BIOSKETCH_PROMPT_VERSION_DEFAULT = "v6";
      expect(defaultBiosketchPromptVersionId()).toBe("v6");
    });
  });

  it("resolveBiosketchPromptImpl maps id → systemPrompt, falling back when invalid", () => {
    expect(resolveBiosketchPromptImpl("v5").id).toBe("v5");
    expect(resolveBiosketchPromptImpl("v5").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT);
    expect(resolveBiosketchPromptImpl("v6").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT_V6);
    expect(resolveBiosketchPromptImpl("v7").systemPrompt).toBe(BIOSKETCH_SYSTEM_PROMPT_V7);
    // invalid → live default (v7 unless the env lever says otherwise)
    expect(resolveBiosketchPromptImpl("bogus").id).toBe("v7");
  });

  it("the impl map exposes exactly the four versions", () => {
    expect(Object.keys(BIOSKETCH_PROMPT_IMPLS).sort()).toEqual(["v5", "v6", "v7", "v8"]);
  });
});

describe("biosketch system prompts — byte-identity + v6 content", () => {
  it("v5 (BIOSKETCH_SYSTEM_PROMPT) is byte-identical — the baseline must not drift", () => {
    expect(sha(BIOSKETCH_SYSTEM_PROMPT)).toBe(
      "ec32440f49a4a08d597660e633b1989b04d7f19e5bad37372ae002ca07682bdb",
    );
  });

  it("v6 (BIOSKETCH_SYSTEM_PROMPT_V6) is byte-identical — the rollback target must not drift", () => {
    // v6 is now the documented one-step-back rollback target for the v7 default, so pin it like v5.
    //
    // MOVED ONCE, DELIBERATELY (#2064, was …bccfc5): v6 and v7 SHARE
    // `BIOSKETCH_ELEMENTS_V6`, whose element-(iv) block used to enumerate the permitted
    // role vocabulary as "PI / co-PI / co-Investigator". That is an NSF term and is wrong
    // on an NIH award, and it had become actively harmful: FACTS + the ALLOWED_FACTS
    // grounding reference now carry "Multiple Principal Investigator (MPI)", so a v6 draft
    // obeying the old wording would write "co-PI", `verifyDraftGrounding` would flag it as
    // ungrounded, and `reviseDraftForGrounding` would DELETE the mandatory role element.
    // Rolling back to a prompt that fights the verifier is not a usable rollback, so the
    // fix had to reach v6 too. The pin still guards against ACCIDENTAL drift.
    expect(sha(BIOSKETCH_SYSTEM_PROMPT_V6)).toBe(
      "216964dcb9b175ccf0cbc5fa1a9fe8698e5eae193d2b43cd8225c75ca2375276",
    );
  });

  // #2064 — the belt-and-braces half of the MPI fix (the load-bearing half is the
  // roleLabel in FACTS + ALLOWED_FACTS). Both live versions share the elements block,
  // so both must name the role correctly.
  it.each([
    ["v6", BIOSKETCH_SYSTEM_PROMPT_V6],
    ["v7", BIOSKETCH_SYSTEM_PROMPT_V7],
  ])("%s permits MPI and forbids the NSF 'co-PI' term for the role element", (_id, prompt) => {
    expect(prompt).toContain("(PI / MPI / Co-Investigator of <grant title>)");
    expect(prompt).toContain("NIH multiple-PD/PI award");
    expect(prompt).toMatch(/NEVER as "co-PI"/);
    // The old permitted-vocabulary line must be gone, not merely supplemented.
    expect(prompt).not.toContain("(PI / co-PI / co-Investigator of <grant title>)");
    // The model is pointed at the LABEL, not the raw abbreviation.
    expect(prompt).toContain("`roleLabel`");
  });

  it("v7 (BIOSKETCH_SYSTEM_PROMPT_V7) is byte-identical — the v8 rollback target must not drift", () => {
    // #2653 — pinned when v8 landed, computed from origin/master's v7 (identical to this branch's).
    expect(sha(BIOSKETCH_SYSTEM_PROMPT_V7)).toBe(
      "9a7f8678eec5563e13eaa87b915a481cc8b159ba1af103d14b613787cfc70087",
    );
  });

  it("v8 adds the role-on-application block and the keyed reference contract on top of v7 (#2653)", () => {
    const v8 = BIOSKETCH_SYSTEM_PROMPT_V8;
    expect(v8).not.toBe(BIOSKETCH_SYSTEM_PROMPT_V7);
    expect(v8).toContain("ROLE ON THE APPLICATION");
    expect(v8).toContain("PRODUCT REFERENCES");
    expect(v8).toContain("[P2, P5]");
    // the v6 loose-reference block is REPLACED, not stacked
    expect(v8).not.toContain("REFERENCES INSIDE THE NARRATIVE");
    // carries the v7 register unchanged (title, four elements, grounded impact, em-dash ban, floor)
    expect(v8).toContain("TITLE EACH CONTRIBUTION");
    expect(v8).toContain("FOUR REQUIRED ELEMENTS");
    expect(v8).toContain("IMPACT, GROUNDED CONDITIONALLY");
    expect(v8).toContain("Do not use em dashes or en dashes");
    expect(v8).toContain("Use only what FACTS contains.");
    expect(v8).toMatch(/NEVER as "co-PI"/);
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

  it("v7 adds the title directive on top of the v6 register", () => {
    const v7 = BIOSKETCH_SYSTEM_PROMPT_V7;
    // distinct from v6, but a strict superset of its grounding/impact register
    expect(v7).not.toBe(BIOSKETCH_SYSTEM_PROMPT_V6);
    expect(v7).toContain("TITLE EACH CONTRIBUTION");
    expect(v7).toContain('TITLE:');
    // carries the v6 directives unchanged (role, four elements, grounded impact, em-dash ban)
    expect(v7).toContain("FOUR REQUIRED ELEMENTS");
    expect(v7).toContain("IMPACT, GROUNDED CONDITIONALLY");
    expect(v7).toContain("Do not use em dashes or en dashes");
    // and the shared entity-provenance floor
    expect(v7).toContain("Use only what FACTS contains.");
  });
});
