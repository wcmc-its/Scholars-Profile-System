import { describe, expect, it } from "vitest";

import { computeOverviewOrigin } from "@/lib/edit/overview-provenance";
import { sanitizeOverview, sanitizeOverviewHtml } from "@/lib/edit/validators";
import {
  hasOverviewTailArtifact,
  stripOverviewTailArtifacts,
} from "@/lib/text/overview-artifacts";
import { getEffectiveOverview } from "@/lib/api/manual-layer";

/** The exact byte sequence #2207 verified in live prod HTML on 59 overviews. */
const PROD_TAIL = "<p>Dr. X studies vascular biology.</p> <p></p> <p>[...]</p>";

describe("stripOverviewTailArtifacts (#2207)", () => {
  it("removes the prod tail — empty paragraph AND truncation sentinel", () => {
    expect(stripOverviewTailArtifacts(PROD_TAIL)).toBe(
      "<p>Dr. X studies vascular biology.</p>",
    );
  });

  it("leaves a clean body byte-identical, trailing newline included", () => {
    const clean = "<p>One.</p>\n<p>Two.</p>\n";
    expect(stripOverviewTailArtifacts(clean)).toBe(clean);
    expect(hasOverviewTailArtifact(clean)).toBe(false);
  });

  it("keeps a mid-document ellipsis — a real elision inside a quotation", () => {
    const quoted = "<p>She wrote &quot;the results [...] were clear&quot;.</p>";
    expect(stripOverviewTailArtifacts(quoted)).toBe(quoted);
    expect(hasOverviewTailArtifact(quoted)).toBe(false);
  });

  it("keeps a trailing bracketed phrase that is NOT an ellipsis", () => {
    const cited = "<p>Prior work.</p><p>[see 1, 2]</p>";
    expect(stripOverviewTailArtifacts(cited)).toBe(cited);
  });

  it("keeps bracketed numerals inside the last paragraph", () => {
    const body = "<p>Interest in [1,2] arrays.</p>";
    expect(stripOverviewTailArtifacts(body)).toBe(body);
  });

  it.each([
    ["dots", "<p>[...]</p>"],
    ["spaced dots", "<p>[. . .]</p>"],
    ["U+2026", "<p>[…]</p>"],
    ["named entity", "<p>[&hellip;]</p>"],
    ["numeric entity", "<p>[&#8230;]</p>"],
    ["padded with nbsp", "<p>&nbsp;[...]&nbsp;</p>"],
    ["uppercase tag with attributes", '<P STYLE="x">[...]</P>'],
  ])("recognizes the sentinel written as %s", (_label, sentinel) => {
    expect(stripOverviewTailArtifacts(`<p>Body.</p>${sentinel}`)).toBe("<p>Body.</p>");
  });

  it.each([
    ["bare", "<p></p>"],
    ["whitespace", "<p>  \n </p>"],
    ["nbsp entity", "<p>&nbsp;</p>"],
    ["a line break", "<p><br></p>"],
    ["a self-closed break", "<p><br /></p>"],
  ])("removes a trailing empty paragraph written as %s", (_label, empty) => {
    expect(stripOverviewTailArtifacts(`<p>Body.</p>${empty}`)).toBe("<p>Body.</p>");
  });

  it("removes a trailing bare <br> run", () => {
    expect(stripOverviewTailArtifacts("<p>Body.</p><br><br />")).toBe("<p>Body.</p>");
  });

  it("unwinds a stack of interleaved empties and sentinels", () => {
    const stacked = "<p>Body.</p>\n<p></p>\n<p>[...]</p>\n<p>&nbsp;</p>\n<p>[…]</p>\n";
    expect(stripOverviewTailArtifacts(stacked)).toBe("<p>Body.</p>");
  });

  it("is idempotent", () => {
    const once = stripOverviewTailArtifacts(PROD_TAIL);
    expect(stripOverviewTailArtifacts(once)).toBe(once);
  });

  it("empties a body that is nothing but the sentinel", () => {
    expect(stripOverviewTailArtifacts("<p></p> <p>[...]</p>")).toBe("");
  });

  it("hasOverviewTailArtifact agrees with the strip", () => {
    expect(hasOverviewTailArtifact(PROD_TAIL)).toBe(true);
    expect(hasOverviewTailArtifact("<p>Body.</p>")).toBe(false);
  });
});

describe("sanitizeOverviewHtml applies the strip (#2207)", () => {
  it("drops the tail on the shared sanitize boundary", () => {
    expect(sanitizeOverviewHtml(PROD_TAIL)).toBe("<p>Dr. X studies vascular biology.</p>");
  });

  it("normalizes a sentinel-only body to the empty overview on save", () => {
    const result = sanitizeOverview("<p></p> <p>[...]</p>");
    expect(result).toEqual({ ok: true, value: "" });
  });

  it("still sanitizes markup while stripping the tail", () => {
    const out = sanitizeOverviewHtml('<p>Hi<script>alert(1)</script></p><p>[...]</p>');
    expect(out).toBe("<p>Hi</p>");
  });

  // `computeOverviewOrigin` classifies a save as "generated" only on BYTE
  // equality with the draft, and its doc warns that any new empty-collapse rule
  // must land on BOTH sanitizers or verbatim saves mis-classify as
  // "generated_edited". The strip lives inside `sanitizeOverviewHtml`, which the
  // generate path and (via `sanitizeOverview`) the save path both run — this
  // pins that.
  it("keeps the generate and save sanitizers byte-compatible", () => {
    const draft = sanitizeOverviewHtml("<p>Generated prose.</p><p></p>");
    expect(draft).toBe("<p>Generated prose.</p>");
    expect(sanitizeOverview(draft)).toEqual({ ok: true, value: draft });
    expect(computeOverviewOrigin(draft, draft)).toBe("generated");
  });
});

describe("getEffectiveOverview heals the stored VIVO seed (#2207)", () => {
  const noOverride = {
    fieldOverride: { findUnique: async () => null },
  } as unknown as Parameters<typeof getEffectiveOverview>[2];

  it("strips the tail from the ETL column on read", async () => {
    expect(await getEffectiveOverview("cwid1", PROD_TAIL, noOverride)).toBe(
      "<p>Dr. X studies vascular biology.</p>",
    );
  });

  it("returns null when the seed was nothing but the sentinel", async () => {
    expect(await getEffectiveOverview("cwid1", "<p></p> <p>[...]</p>", noOverride)).toBeNull();
  });

  it("strips the tail from a pasted override too", async () => {
    const withOverride = {
      fieldOverride: { findUnique: async () => ({ value: PROD_TAIL }) },
    } as unknown as Parameters<typeof getEffectiveOverview>[2];
    expect(await getEffectiveOverview("cwid1", null, withOverride)).toBe(
      "<p>Dr. X studies vascular biology.</p>",
    );
  });
});
