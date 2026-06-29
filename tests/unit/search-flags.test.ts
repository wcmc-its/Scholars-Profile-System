/**
 * Issue #259 SPEC §7.1 + §6.2 — shared flag-resolution and URL-param parsing
 * for the pub-tab concept-mode rebalance.
 *
 * Three call sites (search.ts body builder, route.ts handler, page.tsx
 * SSR) all depend on these helpers agreeing on the precedence rules.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseMeshParam,
  resolveConceptMode,
  resolveDeptLeadershipBoost,
  resolveFundingConceptEnabled,
  resolveFundingMeshGateField,
  resolveFundingPhraseBoost,
  resolveFundingTabMsm,
  resolveFundingTextEvidence,
  resolvePeopleConceptGrantAxis,
  resolvePeopleConceptPrecount,
  resolvePeopleMethodFamilyBoost,
  resolvePeopleMethodContextBoost,
  resolveSearchShellStreaming,
  resolveSearchPeopleDivisionShape,
} from "@/lib/api/search-flags";

describe("resolveConceptMode (§7.1)", () => {
  const originalNew = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;

  beforeEach(() => {
    delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  });

  afterEach(() => {
    if (originalNew === undefined) delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
    else process.env.SEARCH_PUB_TAB_CONCEPT_MODE = originalNew;
  });

  it("defaults to 'expanded' when the env is unset (PR-4 default)", () => {
    expect(resolveConceptMode()).toBe("expanded");
  });

  it("returns the env's value when set ∈ {strict, expanded, off}", () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    expect(resolveConceptMode()).toBe("strict");
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    expect(resolveConceptMode()).toBe("expanded");
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "off";
    expect(resolveConceptMode()).toBe("off");
  });

  it("ignores unknown values and falls back to the default", () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "garbage";
    expect(resolveConceptMode()).toBe("expanded");
  });
});

describe("parseMeshParam (§6.2 precedence)", () => {
  it("URLSearchParams: mesh=off alone → meshOff true, meshStrict false", () => {
    const sp = new URLSearchParams("mesh=off");
    expect(parseMeshParam(sp)).toEqual({ meshOff: true, meshStrict: false });
  });

  it("URLSearchParams: mesh=strict alone → meshStrict true, meshOff false", () => {
    const sp = new URLSearchParams("mesh=strict");
    expect(parseMeshParam(sp)).toEqual({ meshOff: false, meshStrict: true });
  });

  it("URLSearchParams: mesh=off&mesh=strict → off wins (off first)", () => {
    const sp = new URLSearchParams("mesh=off&mesh=strict");
    expect(parseMeshParam(sp)).toEqual({ meshOff: true, meshStrict: false });
  });

  it("URLSearchParams: mesh=strict&mesh=off → off wins (order-agnostic)", () => {
    // This is the case `params.get('mesh') === 'off'` got wrong — it returned
    // 'strict' (the first value) and silently mis-honored the precedence rule.
    const sp = new URLSearchParams("mesh=strict&mesh=off");
    expect(parseMeshParam(sp)).toEqual({ meshOff: true, meshStrict: false });
  });

  it("URLSearchParams: no mesh param → both false", () => {
    const sp = new URLSearchParams("q=EHR");
    expect(parseMeshParam(sp)).toEqual({ meshOff: false, meshStrict: false });
  });

  it("URLSearchParams: unknown mesh value → both false", () => {
    const sp = new URLSearchParams("mesh=garbage");
    expect(parseMeshParam(sp)).toEqual({ meshOff: false, meshStrict: false });
  });

  it("Next-style searchParams record with string value", () => {
    expect(parseMeshParam({ mesh: "strict" })).toEqual({
      meshOff: false,
      meshStrict: true,
    });
  });

  it("Next-style searchParams record with array value, off wins regardless of position", () => {
    expect(parseMeshParam({ mesh: ["strict", "off"] })).toEqual({
      meshOff: true,
      meshStrict: false,
    });
    expect(parseMeshParam({ mesh: ["off", "strict"] })).toEqual({
      meshOff: true,
      meshStrict: false,
    });
  });

  it("Next-style searchParams record with undefined → both false", () => {
    expect(parseMeshParam({})).toEqual({ meshOff: false, meshStrict: false });
    expect(parseMeshParam({ mesh: undefined })).toEqual({
      meshOff: false,
      meshStrict: false,
    });
  });
});

describe("resolveFundingConceptEnabled (#295)", () => {
  const original = process.env.SEARCH_FUNDING_TAB_CONCEPT;

  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TAB_CONCEPT;
    else process.env.SEARCH_FUNDING_TAB_CONCEPT = original;
  });

  it("defaults to true (on) when the env is unset", () => {
    expect(resolveFundingConceptEnabled()).toBe(true);
  });

  it("is off only for exactly 'off'", () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "off";
    expect(resolveFundingConceptEnabled()).toBe(false);
  });

  it("is on for 'on' and any other non-'off' value", () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    expect(resolveFundingConceptEnabled()).toBe(true);
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "ON";
    expect(resolveFundingConceptEnabled()).toBe(true);
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "true";
    expect(resolveFundingConceptEnabled()).toBe(true);
  });
});

describe("resolveFundingTabMsm (Tier 1 relevance gate)", () => {
  const original = process.env.SEARCH_FUNDING_TAB_MSM;

  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TAB_MSM;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TAB_MSM;
    else process.env.SEARCH_FUNDING_TAB_MSM = original;
  });

  it("defaults to false (dark) when the env is unset", () => {
    expect(resolveFundingTabMsm()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_FUNDING_TAB_MSM = "on";
    expect(resolveFundingTabMsm()).toBe(true);
  });

  it("is off for 'off', 'ON', 'true', or any other non-'on' value", () => {
    process.env.SEARCH_FUNDING_TAB_MSM = "off";
    expect(resolveFundingTabMsm()).toBe(false);
    process.env.SEARCH_FUNDING_TAB_MSM = "ON";
    expect(resolveFundingTabMsm()).toBe(false);
    process.env.SEARCH_FUNDING_TAB_MSM = "true";
    expect(resolveFundingTabMsm()).toBe(false);
    process.env.SEARCH_FUNDING_TAB_MSM = "1";
    expect(resolveFundingTabMsm()).toBe(false);
  });
});

describe("resolveFundingPhraseBoost (Tier 2 phrase-first ranking)", () => {
  const original = process.env.SEARCH_FUNDING_PHRASE_BOOST;

  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_PHRASE_BOOST;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_PHRASE_BOOST;
    else process.env.SEARCH_FUNDING_PHRASE_BOOST = original;
  });

  it("defaults to false (dark) when the env is unset", () => {
    expect(resolveFundingPhraseBoost()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "on";
    expect(resolveFundingPhraseBoost()).toBe(true);
  });

  it("is off for 'off', 'ON', 'true', or any other non-'on' value", () => {
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "off";
    expect(resolveFundingPhraseBoost()).toBe(false);
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "ON";
    expect(resolveFundingPhraseBoost()).toBe(false);
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "true";
    expect(resolveFundingPhraseBoost()).toBe(false);
    process.env.SEARCH_FUNDING_PHRASE_BOOST = "1";
    expect(resolveFundingPhraseBoost()).toBe(false);
  });
});

describe("resolveFundingTextEvidence (Tier 3 text-hit evidence line)", () => {
  const original = process.env.SEARCH_FUNDING_TEXT_EVIDENCE;

  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_TEXT_EVIDENCE;
    else process.env.SEARCH_FUNDING_TEXT_EVIDENCE = original;
  });

  it("defaults to false (dark) when the env is unset", () => {
    expect(resolveFundingTextEvidence()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "on";
    expect(resolveFundingTextEvidence()).toBe(true);
  });

  it("is off for 'off', 'ON', 'true', or any other non-'on' value", () => {
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "off";
    expect(resolveFundingTextEvidence()).toBe(false);
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "ON";
    expect(resolveFundingTextEvidence()).toBe(false);
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "true";
    expect(resolveFundingTextEvidence()).toBe(false);
    process.env.SEARCH_FUNDING_TEXT_EVIDENCE = "1";
    expect(resolveFundingTextEvidence()).toBe(false);
  });
});

describe("resolvePeopleConceptGrantAxis (#921)", () => {
  const original = process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;

  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS;
    else process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = original;
  });

  it("defaults to false (dark) when the env is unset", () => {
    expect(resolvePeopleConceptGrantAxis()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "on";
    expect(resolvePeopleConceptGrantAxis()).toBe(true);
  });

  it("stays off for any other value (opt-in semantics)", () => {
    process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "ON";
    expect(resolvePeopleConceptGrantAxis()).toBe(false);
    process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "true";
    expect(resolvePeopleConceptGrantAxis()).toBe(false);
    process.env.SEARCH_PEOPLE_CONCEPT_GRANT_AXIS = "";
    expect(resolvePeopleConceptGrantAxis()).toBe(false);
  });
});

describe("resolvePeopleMethodFamilyBoost (#824 §4c)", () => {
  const original = process.env.SEARCH_PEOPLE_METHOD_FAMILY;

  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_METHOD_FAMILY;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_METHOD_FAMILY;
    else process.env.SEARCH_PEOPLE_METHOD_FAMILY = original;
  });

  it("defaults to false (off) when the env is unset — reindex-then-flip, ships inert", () => {
    expect(resolvePeopleMethodFamilyBoost()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_PEOPLE_METHOD_FAMILY = "on";
    expect(resolvePeopleMethodFamilyBoost()).toBe(true);
  });

  it("stays off for any other value (opt-in `=== \"on\"` semantics)", () => {
    process.env.SEARCH_PEOPLE_METHOD_FAMILY = "ON";
    expect(resolvePeopleMethodFamilyBoost()).toBe(false);
    process.env.SEARCH_PEOPLE_METHOD_FAMILY = "true";
    expect(resolvePeopleMethodFamilyBoost()).toBe(false);
    process.env.SEARCH_PEOPLE_METHOD_FAMILY = "";
    expect(resolvePeopleMethodFamilyBoost()).toBe(false);
  });
});

describe("resolvePeopleMethodContextBoost (#1119)", () => {
  const original = process.env.SEARCH_PEOPLE_METHOD_CONTEXT;

  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_METHOD_CONTEXT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_METHOD_CONTEXT;
    else process.env.SEARCH_PEOPLE_METHOD_CONTEXT = original;
  });

  it("defaults to false (off) when unset — reindex-then-flip, ships inert", () => {
    expect(resolvePeopleMethodContextBoost()).toBe(false);
  });

  it("is on only for exactly 'on'", () => {
    process.env.SEARCH_PEOPLE_METHOD_CONTEXT = "on";
    expect(resolvePeopleMethodContextBoost()).toBe(true);
  });

  it("stays off for any other value (opt-in `=== \"on\"` semantics)", () => {
    for (const v of ["ON", "true", ""]) {
      process.env.SEARCH_PEOPLE_METHOD_CONTEXT = v;
      expect(resolvePeopleMethodContextBoost()).toBe(false);
    }
  });
});

describe("resolveDeptLeadershipBoost (#532)", () => {
  const original = process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST;

  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST;
    else process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = original;
  });

  it("defaults to true when the env is unset (post-2026-05-28 default-on)", () => {
    expect(resolveDeptLeadershipBoost()).toBe(true);
  });

  it("is false only for exactly 'off' (the documented rollback literal)", () => {
    process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = "off";
    expect(resolveDeptLeadershipBoost()).toBe(false);
  });

  it("is true for any value that is not 'off' (including 'on' and casing variants of 'off')", () => {
    process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = "on";
    expect(resolveDeptLeadershipBoost()).toBe(true);
    // Casing only matters for the literal 'off' — 'OFF' is NOT the rollback
    // string. Documenting via test so a future operator doesn't assume
    // lenient casing on the rollback path.
    process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = "OFF";
    expect(resolveDeptLeadershipBoost()).toBe(true);
    process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = "true";
    expect(resolveDeptLeadershipBoost()).toBe(true);
    process.env.SEARCH_PEOPLE_DEPT_LEADERSHIP_BOOST = "";
    expect(resolveDeptLeadershipBoost()).toBe(true);
  });
});

describe("resolveSearchPeopleDivisionShape (#1347)", () => {
  const original = process.env.SEARCH_PEOPLE_DIVISION_SHAPE;
  beforeEach(() => delete process.env.SEARCH_PEOPLE_DIVISION_SHAPE);
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_DIVISION_SHAPE;
    else process.env.SEARCH_PEOPLE_DIVISION_SHAPE = original;
  });

  it("defaults to false (dark)", () => {
    expect(resolveSearchPeopleDivisionShape()).toBe(false);
  });
  it("is true only for exactly 'on'", () => {
    process.env.SEARCH_PEOPLE_DIVISION_SHAPE = "on";
    expect(resolveSearchPeopleDivisionShape()).toBe(true);
    process.env.SEARCH_PEOPLE_DIVISION_SHAPE = "ON";
    expect(resolveSearchPeopleDivisionShape()).toBe(false);
    process.env.SEARCH_PEOPLE_DIVISION_SHAPE = "off";
    expect(resolveSearchPeopleDivisionShape()).toBe(false);
  });
});

describe("resolveFundingMeshGateField (funding reindex)", () => {
  const original = process.env.SEARCH_FUNDING_MESH_GATE;
  beforeEach(() => {
    delete process.env.SEARCH_FUNDING_MESH_GATE;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_FUNDING_MESH_GATE;
    else process.env.SEARCH_FUNDING_MESH_GATE = original;
  });

  it("defaults to the safe meshDescriptorUi gate when unset", () => {
    expect(resolveFundingMeshGateField()).toBe("meshDescriptorUi");
  });

  it("returns fundedPubMeshUi only for exactly 'fundedPubMeshUi'", () => {
    process.env.SEARCH_FUNDING_MESH_GATE = "fundedPubMeshUi";
    expect(resolveFundingMeshGateField()).toBe("fundedPubMeshUi");
  });

  it("falls through to meshDescriptorUi for any unrecognized value", () => {
    process.env.SEARCH_FUNDING_MESH_GATE = "on";
    expect(resolveFundingMeshGateField()).toBe("meshDescriptorUi");
    process.env.SEARCH_FUNDING_MESH_GATE = "FUNDEDPUBMESHUI";
    expect(resolveFundingMeshGateField()).toBe("meshDescriptorUi");
  });
});

describe("resolveSearchShellStreaming (#861)", () => {
  const original = process.env.SEARCH_SHELL_STREAMING;
  beforeEach(() => {
    delete process.env.SEARCH_SHELL_STREAMING;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_SHELL_STREAMING;
    else process.env.SEARCH_SHELL_STREAMING = original;
  });

  it("defaults to false when unset (ships inert — legacy single-await render)", () => {
    expect(resolveSearchShellStreaming()).toBe(false);
  });

  it("is true only for exactly 'on' (the documented enable literal)", () => {
    process.env.SEARCH_SHELL_STREAMING = "on";
    expect(resolveSearchShellStreaming()).toBe(true);
  });

  it("is false for any value that is not 'on' (including casing variants)", () => {
    // Casing matters: only the literal 'on' enables streaming, mirroring the
    // other default-off `=== "on"` gates (SEARCH_PUB_DEPARTMENT_FILTER).
    process.env.SEARCH_SHELL_STREAMING = "ON";
    expect(resolveSearchShellStreaming()).toBe(false);
    process.env.SEARCH_SHELL_STREAMING = "off";
    expect(resolveSearchShellStreaming()).toBe(false);
    process.env.SEARCH_SHELL_STREAMING = "true";
    expect(resolveSearchShellStreaming()).toBe(false);
    process.env.SEARCH_SHELL_STREAMING = "";
    expect(resolveSearchShellStreaming()).toBe(false);
  });
});

describe("resolvePeopleConceptPrecount (B2)", () => {
  const original = process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
  beforeEach(() => {
    delete process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT;
    else process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = original;
  });

  it("defaults to true when unset (ships dark — today's dedicated pre-count path)", () => {
    expect(resolvePeopleConceptPrecount()).toBe(true);
  });

  it("is false only for exactly 'off' (enables the reordered no-pre-count path)", () => {
    process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = "off";
    expect(resolvePeopleConceptPrecount()).toBe(false);
  });

  it("is true for any value that is not 'off' (default-on `!== \"off\"` lever)", () => {
    // Mirrors the other default-on presentation/perf flags: only the literal
    // 'off' flips it; everything else (incl. casing variants) keeps it on.
    process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = "on";
    expect(resolvePeopleConceptPrecount()).toBe(true);
    process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = "OFF";
    expect(resolvePeopleConceptPrecount()).toBe(true);
    process.env.SEARCH_PEOPLE_CONCEPT_PRECOUNT = "";
    expect(resolvePeopleConceptPrecount()).toBe(true);
  });
});
