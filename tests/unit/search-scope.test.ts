/**
 * PLAN R2/R6 — the unified match-scope contract.
 *
 * `parseScopeParam` reads `?match=exact|expanded|concept` (default expanded) and
 * falls back to the legacy `?mesh=` alias for one release. `scopeToMeshParams`
 * bridges the scope onto the existing `meshOff`/`meshStrict` query levers so the
 * `expanded` default is byte-identical to the pre-scope query. `buildScopeHref`
 * writes the `?match=` URL, dropping it for the default and stripping the
 * legacy `mesh` param + `page`/`sort` on every transition.
 */
import { describe, expect, it } from "vitest";
import { parseScopeParam, scopeToMeshParams } from "@/lib/api/search-flags";
import { buildScopeHref } from "@/app/(public)/search/url-helpers";

function parse(href: string): URLSearchParams {
  const idx = href.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : href.slice(idx + 1));
}

describe("parseScopeParam", () => {
  it("defaults to expanded when no param is present", () => {
    expect(parseScopeParam({})).toBe("expanded");
    expect(parseScopeParam(new URLSearchParams())).toBe("expanded");
  });

  it("reads each explicit match value", () => {
    expect(parseScopeParam({ match: "exact" })).toBe("exact");
    expect(parseScopeParam({ match: "expanded" })).toBe("expanded");
    expect(parseScopeParam({ match: "concept" })).toBe("concept");
    expect(parseScopeParam(new URLSearchParams("match=concept"))).toBe("concept");
  });

  it("falls through to expanded for an unrecognized match value", () => {
    expect(parseScopeParam({ match: "wat" })).toBe("expanded");
  });

  it("maps the legacy ?mesh= alias when match is absent", () => {
    expect(parseScopeParam({ mesh: "off" })).toBe("exact");
    expect(parseScopeParam({ mesh: "strict" })).toBe("concept");
    expect(parseScopeParam(new URLSearchParams("mesh=off"))).toBe("exact");
  });

  it("prefers match over the legacy mesh alias", () => {
    expect(parseScopeParam({ match: "expanded", mesh: "off" })).toBe("expanded");
    expect(parseScopeParam(new URLSearchParams("match=exact&mesh=strict"))).toBe("exact");
  });

  it("honors off-wins precedence within the mesh alias (array values)", () => {
    expect(parseScopeParam({ mesh: ["strict", "off"] })).toBe("exact");
    expect(parseScopeParam(new URLSearchParams("mesh=strict&mesh=off"))).toBe("exact");
  });
});

describe("scopeToMeshParams", () => {
  it("expanded → today's default (neither lever set, byte-identical)", () => {
    expect(scopeToMeshParams("expanded")).toEqual({ meshOff: false, meshStrict: false });
  });

  it("exact → meshOff (literal-only admission)", () => {
    expect(scopeToMeshParams("exact")).toEqual({ meshOff: true, meshStrict: false });
  });

  it("concept → meshStrict (concept-only admission)", () => {
    expect(scopeToMeshParams("concept")).toEqual({ meshOff: false, meshStrict: true });
  });

  it("round-trips the legacy aliases to their original lever values", () => {
    // ?mesh=off and ?mesh=strict must produce the same levers post-bridge as pre-scope.
    expect(scopeToMeshParams(parseScopeParam({ mesh: "off" }))).toEqual({
      meshOff: true,
      meshStrict: false,
    });
    expect(scopeToMeshParams(parseScopeParam({ mesh: "strict" }))).toEqual({
      meshOff: false,
      meshStrict: true,
    });
    expect(scopeToMeshParams(parseScopeParam({}))).toEqual({
      meshOff: false,
      meshStrict: false,
    });
  });
});

describe("buildScopeHref", () => {
  it("drops the param entirely for the default expanded scope", () => {
    expect(buildScopeHref({ q: "microbiome", type: "people" }, "expanded")).toBe(
      "/search?q=microbiome&type=people",
    );
  });

  it("sets match for exact and concept", () => {
    expect(parse(buildScopeHref({ q: "x" }, "exact")).get("match")).toBe("exact");
    expect(parse(buildScopeHref({ q: "x" }, "concept")).get("match")).toBe("concept");
  });

  it("strips the legacy mesh alias, page, and sort on transition", () => {
    const out = parse(
      buildScopeHref({ q: "x", mesh: "off", page: "3", sort: "impact", type: "publications" }, "concept"),
    );
    expect(out.get("mesh")).toBeNull();
    expect(out.get("page")).toBeNull();
    expect(out.get("sort")).toBeNull();
    expect(out.get("type")).toBe("publications");
    expect(out.get("match")).toBe("concept");
  });

  it("overwrites an existing match param (no double-match URLs)", () => {
    const out = parse(buildScopeHref({ q: "x", match: "exact" }, "concept"));
    expect(out.getAll("match")).toEqual(["concept"]);
  });

  it("preserves repeated multi-select params in order", () => {
    const out = parse(buildScopeHref({ q: "x", journal: ["Nature", "Cell"] }, "exact"));
    expect(out.getAll("journal")).toEqual(["Nature", "Cell"]);
  });

  it("returns bare /search when no params survive", () => {
    expect(buildScopeHref({ page: "2" }, "expanded")).toBe("/search");
  });
});
