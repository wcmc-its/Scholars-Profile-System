/**
 * SEARCH_PUB_HIGHLIGHT — `highlightedTitleHtml` restyles the OpenSearch <mark>
 * fragment for a publication title: keep the scientific-notation whitelist
 * (i/em/b/strong/sup/sub) plus <mark>, drop everything else, and recolor the
 * marks as a brand-red accent with the post-it-yellow background reset (#20).
 */
import { describe, expect, it } from "vitest";
import { highlightedTitleHtml } from "@/components/search/publication-result-row";

describe("highlightedTitleHtml", () => {
  it("recolors <mark> to a brand accent and resets the yellow background", () => {
    const out = highlightedTitleHtml("The Traveling <mark>Microbiome</mark>.");
    expect(out).toBe(
      'The Traveling <mark class="bg-transparent text-[#b31b1b]">Microbiome</mark>.',
    );
  });

  it("preserves scientific-notation tags around a mark", () => {
    const out = highlightedTitleHtml("H<sub>2</sub>O and <mark>microbiome</mark>");
    expect(out).toBe(
      'H<sub>2</sub>O and <mark class="bg-transparent text-[#b31b1b]">microbiome</mark>',
    );
  });

  it("strips non-whitelisted tags (e.g. a stray script/span) but keeps marks", () => {
    const out = highlightedTitleHtml(
      '<span onclick="x">A</span> <script>bad()</script> <mark>B</mark>',
    );
    expect(out).toBe('A bad() <mark class="bg-transparent text-[#b31b1b]">B</mark>');
  });

  it("drops mark attributes from the source, applying only our class", () => {
    const out = highlightedTitleHtml('<mark data-x="1">x</mark>');
    expect(out).toBe('<mark class="bg-transparent text-[#b31b1b]">x</mark>');
  });
});
