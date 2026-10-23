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

// One-pass stripping splices the text around a removed tag into a new tag:
// `<<x>script>` loses `<x>` and leaves `<script>`. Every `<` that doesn't open
// a bare whitelisted tag must come out escaped.
const SPLICE_PAYLOAD =
  "Gene <mark>X</mark><<x>script>alert(document.domain)<<x>/script> " +
  "<<x>a href=javascript:alert(1)>see <<x>img src=x onerror=alert(1)>";

/** Parse as the browser would for `dangerouslySetInnerHTML`. */
function render(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("sanitizePubmedHtml — tag-splicing bypass", () => {
  it("escapes tags spliced together by removing the tag inside them", () => {
    const out = sanitizePubmedHtml(SPLICE_PAYLOAD);
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<a /i);
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;");
    const el = render(out);
    expect(el.querySelectorAll("*")).toHaveLength(0);
    expect(el.textContent).toContain("<script>alert(document.domain)</script>");
  });

  it("escapes a spliced whitelisted tag that would carry an attribute", () => {
    expect(sanitizePubmedHtml("<<x>i onclick=alert(1)>x</i>")).toBe("&lt;i onclick=alert(1)>x</i>");
    const el = render(sanitizePubmedHtml("<<x>b onmouseover=alert(1)>x"));
    expect(el.querySelectorAll("[onmouseover]")).toHaveLength(0);
  });

  it("escapes a stray < outside any tag (comparators, comment openers)", () => {
    expect(sanitizePubmedHtml("p < 0.05 and q <0.01")).toBe("p &lt; 0.05 and q &lt;0.01");
    expect(render(sanitizePubmedHtml("p < 0.05")).textContent).toBe("p < 0.05");
    expect(sanitizePubmedHtml("<!-- x")).toBe("&lt;!-- x");
  });

  it("leaves legitimate markup as it was", () => {
    expect(sanitizePubmedHtml("H<sub>2</sub>O")).toBe("H<sub>2</sub>O");
    expect(sanitizePubmedHtml("<i>in vivo</i>")).toBe("<i>in vivo</i>");
    expect(sanitizePubmedHtml('<I class="x">in vivo</I>')).toBe("<i>in vivo</i>");
    expect(sanitizePubmedHtml("p &lt; 0.05")).toBe("p &lt; 0.05");
  });

  it("is idempotent, so a double-sanitized string is unchanged", () => {
    const once = sanitizePubmedHtml(SPLICE_PAYLOAD + " p < 0.05 H<sub>2</sub>O");
    expect(sanitizePubmedHtml(once)).toBe(once);
  });
});
