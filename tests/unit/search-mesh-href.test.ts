/**
 * Issue #259 §6.2 — `buildMeshHref` produces mesh-mode transition links for
 * the ConceptChip with three target modes:
 *
 *   "off"    — "Search broadly instead" (§1.11)
 *   "strict" — "Narrow to this concept only" (§6.1)
 *   "clear"  — drop the mesh param entirely, re-engage default expanded mode
 *
 * Behavior across all modes:
 *
 *   - Preserve every other query param verbatim (filters, tab, q).
 *   - Override any existing `mesh` param (no double-mesh URLs).
 *   - Strip `page` and `sort` on every transition (§1.11 rationale: the
 *     candidate set changes, page offset becomes stale; §1.8 sort options
 *     are tightly coupled to a resolved concept).
 *   - Preserve repeated/multi-select params in their original order so
 *     facet state survives.
 *   - Drop `undefined` values (Next.js parses absent params as undefined,
 *     not "").
 */
import { describe, expect, it } from "vitest";
import { buildMeshHref } from "@/app/(public)/search/url-helpers";

function parse(href: string): URLSearchParams {
  const idx = href.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : href.slice(idx + 1));
}

describe("buildMeshHref (§6.2)", () => {
  it("mode=off — sets mesh=off and preserves q", () => {
    const href = buildMeshHref({ q: "EHR" }, "off");
    expect(parse(href).get("mesh")).toBe("off");
    expect(parse(href).get("q")).toBe("EHR");
  });

  it("mode=strict — sets mesh=strict and preserves q", () => {
    const href = buildMeshHref({ q: "EHR" }, "strict");
    expect(parse(href).get("mesh")).toBe("strict");
    expect(parse(href).get("q")).toBe("EHR");
  });

  it("mode=clear — drops the mesh param entirely", () => {
    const href = buildMeshHref({ q: "EHR", mesh: "strict" }, "clear");
    expect(parse(href).has("mesh")).toBe(false);
    expect(parse(href).get("q")).toBe("EHR");
  });

  it("mode=strict — overrides an existing mesh=off (no double param)", () => {
    const href = buildMeshHref({ q: "EHR", mesh: "off" }, "strict");
    expect(parse(href).getAll("mesh")).toEqual(["strict"]);
  });

  it("mode=clear with an existing mesh=off — drops the param", () => {
    const href = buildMeshHref({ q: "EHR", mesh: "off" }, "clear");
    expect(parse(href).has("mesh")).toBe(false);
  });

  it("strips page and sort on every transition", () => {
    const href = buildMeshHref(
      { q: "EHR", page: "5", sort: "impact" },
      "strict",
    );
    expect(parse(href).has("page")).toBe(false);
    expect(parse(href).has("sort")).toBe(false);
  });

  it("preserves repeated array params in original order", () => {
    const href = buildMeshHref(
      { q: "EHR", journal: ["Nature", "Cell", "JAMA"] },
      "strict",
    );
    expect(parse(href).getAll("journal")).toEqual(["Nature", "Cell", "JAMA"]);
  });

  it("drops undefined values without emitting an empty param", () => {
    const href = buildMeshHref(
      { q: "EHR", type: "publications", sort: undefined },
      "off",
    );
    const p = parse(href);
    expect(p.has("sort")).toBe(false);
    expect(p.get("q")).toBe("EHR");
    expect(p.get("type")).toBe("publications");
  });

  it("returns bare /search when sp is empty and mode=clear", () => {
    expect(buildMeshHref({}, "clear")).toBe("/search");
  });

  it("returns /search?mesh=off when sp is empty and mode=off", () => {
    expect(buildMeshHref({}, "off")).toBe("/search?mesh=off");
  });
});
