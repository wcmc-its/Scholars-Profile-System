/**
 * Issue #259 §1.11 — `buildBroadenHref` produces the "Search broadly
 * instead" link for the ConceptChip. It must:
 *
 *   - Preserve every other query param verbatim (filters, sort, tab, q).
 *   - Set `mesh` to the requested value, overriding any existing `mesh`
 *     param (e.g. when re-entering "broad" mode from a stale URL).
 *   - Clear `page` so the user lands on page 0 of the broader result set
 *     (broadening usually grows the candidate set; the prior page offset
 *     is almost always meaningless after the change).
 *   - Preserve repeated/multi-select params in their original order so
 *     facet state survives.
 *   - Strip `undefined` values (Next.js parses absent params as undefined,
 *     not "").
 */
import { describe, expect, it } from "vitest";
import {
  buildBroadenHref,
  buildMeshHref,
} from "@/app/(public)/search/url-helpers";

function parse(href: string): URLSearchParams {
  const idx = href.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : href.slice(idx + 1));
}

describe("buildBroadenHref (§1.11)", () => {
  it("sets mesh=off and preserves q + type", () => {
    const href = buildBroadenHref(
      { q: "EHR", type: "publications" },
      "off",
    );
    const p = parse(href);
    expect(p.get("mesh")).toBe("off");
    expect(p.get("q")).toBe("EHR");
    expect(p.get("type")).toBe("publications");
  });

  it("clears page so the user lands on page 0 of the broader set", () => {
    const href = buildBroadenHref(
      { q: "EHR", type: "publications", page: "5" },
      "off",
    );
    expect(parse(href).has("page")).toBe(false);
  });

  it("overrides an existing mesh=off when called again (idempotency)", () => {
    const href = buildBroadenHref(
      { q: "EHR", mesh: "off" },
      "off",
    );
    const all = parse(href).getAll("mesh");
    expect(all).toEqual(["off"]);
  });

  it("supports a future 'on' value to re-enable concept resolution", () => {
    // The helper signature accepts "on" so a future affordance ("Resume
    // concept-aware search") can call the same function symmetrically.
    const href = buildBroadenHref({ q: "EHR", mesh: "off" }, "on");
    expect(parse(href).get("mesh")).toBe("on");
  });

  it("preserves repeated array params in original order", () => {
    const href = buildBroadenHref(
      { q: "EHR", journal: ["Nature", "Cell", "JAMA"] },
      "off",
    );
    expect(parse(href).getAll("journal")).toEqual(["Nature", "Cell", "JAMA"]);
  });

  it("drops undefined values without emitting an empty param", () => {
    const href = buildBroadenHref(
      { q: "EHR", type: "publications", sort: undefined },
      "off",
    );
    expect(parse(href).has("sort")).toBe(false);
  });

  it("preserves filters verbatim but drops sort (§1.8 sort options imply concept mode)", () => {
    const href = buildBroadenHref(
      {
        q: "electronic health records",
        type: "publications",
        sort: "impact",
        yearMin: "2020",
        yearMax: "2024",
        publicationType: "Journal Article",
        wcmAuthorRole: ["first", "senior"],
        mentoringProgram: ["md", "phd"],
      },
      "off",
    );
    const p = parse(href);
    // sort is dropped so the page falls back to its default (relevance for
    // non-empty queries; recency for empty pub-tab queries under the §1.8
    // flag). Impact and Recency only make sense when a concept resolved.
    expect(p.has("sort")).toBe(false);
    // User-applied filters survive — broadening is about loosening the
    // concept gate, not throwing away every facet the user set.
    expect(p.get("yearMin")).toBe("2020");
    expect(p.get("yearMax")).toBe("2024");
    expect(p.get("publicationType")).toBe("Journal Article");
    expect(p.getAll("wcmAuthorRole")).toEqual(["first", "senior"]);
    expect(p.getAll("mentoringProgram")).toEqual(["md", "phd"]);
    expect(p.get("mesh")).toBe("off");
  });

  it("drops sort regardless of value (sort=year and sort=recency both gone)", () => {
    for (const sortVal of ["year", "citations", "recency", "impact", "relevance"]) {
      const href = buildBroadenHref({ q: "EHR", sort: sortVal }, "off");
      expect(parse(href).has("sort")).toBe(false);
    }
  });

  it("returns bare /search when sp is empty (degenerate case)", () => {
    // The "?mesh=off" param is still appended, but the prefix is /search?…
    // and the helper never returns a stripped path. This pins the contract.
    const href = buildBroadenHref({}, "off");
    expect(href).toBe("/search?mesh=off");
  });
});

/**
 * Issue #259 §6.2 — `buildMeshHref` supersedes `buildBroadenHref` with three
 * mesh-mode targets: "off" (broaden), "strict" (narrow), and "clear" (drop
 * the param entirely, re-engage default expanded mode).
 */
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

  it("returns bare /search when sp is empty and mode=clear", () => {
    expect(buildMeshHref({}, "clear")).toBe("/search");
  });

  it("returns /search?mesh=off when sp is empty and mode=off", () => {
    expect(buildMeshHref({}, "off")).toBe("/search?mesh=off");
  });
});
