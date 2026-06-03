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

  it("defaults to false when the env is unset", () => {
    expect(resolveFundingConceptEnabled()).toBe(false);
  });

  it("is true only for exactly 'on'", () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "on";
    expect(resolveFundingConceptEnabled()).toBe(true);
  });

  it("is false for any other value (off / casing / truthy strings)", () => {
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "off";
    expect(resolveFundingConceptEnabled()).toBe(false);
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "ON";
    expect(resolveFundingConceptEnabled()).toBe(false);
    process.env.SEARCH_FUNDING_TAB_CONCEPT = "true";
    expect(resolveFundingConceptEnabled()).toBe(false);
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
