/**
 * Whitelist-strip behavior for `sanitizePubmedHtml` (#331).
 *
 * Covers:
 *  - The six allowed tags (`<i>`, `<em>`, `<b>`, `<strong>`, `<sup>`,
 *    `<sub>`) survive both opening and closing forms.
 *  - Anything outside the whitelist is stripped (script, anchor, div).
 *  - Tag attributes are stripped wholesale (no `<i class="…">` survives).
 *  - The PMID 29326275 abstract fixture (CX3CR1<sup>+</sup> mononuclear
 *    phagocytes …) round-trips with `<sup>` / `</sup>` intact.
 *
 * Mirrors the rendering path used by the inline abstract disclosure on
 * the profile/topic/search publication rows.
 */
import { describe, expect, it } from "vitest";
import { sanitizePubmedHtml } from "@/lib/utils";

const PMID_29326275_ABSTRACT =
  "We identified CX3CR1<sup>+</sup> mononuclear phagocytes (MNPs) " +
  "as essential for the initiation of innate and adaptive immune " +
  "responses to fungi. CX3CR1<sup>+</sup> MNPs express antifungal " +
  "receptors and respond to <i>Candida albicans</i> and other " +
  "Mycobiota members.";

describe("sanitizePubmedHtml — whitelist", () => {
  it("preserves the six allowed inline tags (open + close)", () => {
    const tags = ["i", "em", "b", "strong", "sup", "sub"] as const;
    for (const t of tags) {
      const out = sanitizePubmedHtml(`x<${t}>y</${t}>z`);
      expect(out).toBe(`x<${t}>y</${t}>z`);
    }
  });

  it("strips non-whitelisted tags but keeps the inner text", () => {
    expect(sanitizePubmedHtml('<a href="https://x">foo</a>')).toBe("foo");
    expect(sanitizePubmedHtml("<div>foo</div>")).toBe("foo");
    expect(sanitizePubmedHtml("<script>alert(1)</script>x")).toBe("alert(1)x");
  });

  it("strips attributes off whitelisted tags (normalizes to bare form)", () => {
    expect(sanitizePubmedHtml('<i class="foo">x</i>')).toBe("<i>x</i>");
    expect(sanitizePubmedHtml('<sup style="color:red">+</sup>')).toBe(
      "<sup>+</sup>",
    );
    // No `class=`, `style=`, or `onmouseover=` survives.
    const out = sanitizePubmedHtml('<i onclick="x">y</i>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("=");
  });

  it("PMID 29326275 abstract round-trips with sup + i intact", () => {
    const out = sanitizePubmedHtml(PMID_29326275_ABSTRACT);
    expect(out).toContain("CX3CR1<sup>+</sup>");
    expect(out).toContain("<i>Candida albicans</i>");
    // Whitelist is exactly six tags; nothing else should leak in.
    const stray = out.match(/<\/?(?!(?:i|em|b|strong|sup|sub)\b)[a-z][^>]*>/gi);
    expect(stray).toBeNull();
  });
});
