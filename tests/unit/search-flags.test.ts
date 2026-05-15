/**
 * Issue #259 SPEC §7.1 + §7.1.1 + §6.2 — shared flag-resolution and
 * URL-param parsing for the pub-tab concept-mode rebalance.
 *
 * Three call sites (search.ts body builder, route.ts handler, page.tsx
 * SSR) all depend on these helpers agreeing on the precedence rules.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseMeshParam,
  resolveConceptMode,
} from "@/lib/api/search-flags";

describe("resolveConceptMode (§7.1 + §7.1.1)", () => {
  const originalNew = process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
  const originalLegacy = process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE;

  beforeEach(() => {
    delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
    delete process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE;
  });

  afterEach(() => {
    if (originalNew === undefined) delete process.env.SEARCH_PUB_TAB_CONCEPT_MODE;
    else process.env.SEARCH_PUB_TAB_CONCEPT_MODE = originalNew;
    if (originalLegacy === undefined) delete process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE;
    else process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = originalLegacy;
  });

  it("defaults to 'expanded' when both envs are unset (PR-4 default)", () => {
    expect(resolveConceptMode()).toBe("expanded");
  });

  it("returns the new env's value when set ∈ {strict, expanded, off}", () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "strict";
    expect(resolveConceptMode()).toBe("strict");
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    expect(resolveConceptMode()).toBe("expanded");
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "off";
    expect(resolveConceptMode()).toBe("off");
  });

  it("ignores unknown new-env values and falls back to legacy/default", () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "garbage";
    expect(resolveConceptMode()).toBe("expanded");
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "off";
    expect(resolveConceptMode()).toBe("off");
  });

  it("legacy OR_OF_EVIDENCE=on maps to strict (legacy default-on prod state)", () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "on";
    expect(resolveConceptMode()).toBe("strict");
  });

  it("legacy OR_OF_EVIDENCE=off maps to off", () => {
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "off";
    expect(resolveConceptMode()).toBe("off");
  });

  it("new env wins over legacy when both are set", () => {
    process.env.SEARCH_PUB_TAB_CONCEPT_MODE = "expanded";
    process.env.SEARCH_PUB_TAB_OR_OF_EVIDENCE = "off";
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
