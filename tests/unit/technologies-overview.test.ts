/**
 * `parseOverview` — the "Technology Overview" extractor for the CTL scraper.
 *
 * Fixtures are real markup copied from the harvested portfolio (public
 * marketing pages, no PII), trimmed to the overview region. The extractor was
 * validated against all 260 harvested pages: 157 carry an overview (134 bullet,
 * 23 prose) and 115 a "PoC Data" bullet. These cases pin the behaviours that
 * distinguish it from a naive text match:
 *   - bullet form → bullets joined one per line, PoC flag set
 *   - prose form → the paragraph text, PoC flag clear
 *   - the 103-page meta-description trap → null (body-scoped, never head)
 *   - absent section → null
 *   - control bytes stripped from the output
 */
import { describe, expect, it } from "vitest";

import { parseOverview } from "@/etl/technologies/scrape";

const page = (head: string, body: string) =>
  `<html><head>${head}</head><body>${body}</body></html>`;

// Real bullet-form overview (3-HKA analogs), verbatim from the portfolio.
const BULLET_BODY = `<div class="field-content-items"><p><strong>Technology Overview</strong></p><ul><li><strong>The Technology:</strong> Method to treat autoimmune diseases using 3-HKA and its analogs</li><li><strong>The Discovery:</strong> 3-hydroxykynurenine (3-HKA) is a previously undescribed biogenic amine with anti-inflammatory and immunosuppressive capabilities in vivo and in vitro</li><li><strong>PoC Data:</strong> 3-HKA inhibits the IFN-g-receptor and NF-kB activation and decreases inflammatory T-cell proliferation in mouse models</li><li>IDO1 knockout leads to an increase in inflammation, and exacerbates psoriasis in mice models</li></ul><p><strong>Technology Applications</strong></p><ul><li>Development of 3-HKA and its analogs as potent treatments of autoimmune diseases</li></ul>`;

// Real prose-form overview (cyclodextrin polymers), two paragraphs.
const PROSE_BODY = `<div class="field-content-items"><p><strong>Technology Overview</strong></p><p>Nieman-Pick type C disease (NPC) is a lysosomal storage disorder causing accumulation of unesterified cholesterol in lysosomal storage organelles (LSO).</p><p>The inventors studied the mechanisms and demonstrated that reduction in cholesterol accumulation in NPC is due to CD action from inside late endosomes/lysosomes.</p><p><strong>Technology Applications</strong></p><ul><li>Treatment of NPC</li></ul>`;

describe("parseOverview — bullet form", () => {
  it("joins the overview bullets one per line, keeping labels inline", () => {
    const { overview } = parseOverview(page("", BULLET_BODY));
    const lines = overview!.split("\n");
    expect(lines[0]).toBe(
      "The Technology: Method to treat autoimmune diseases using 3-HKA and its analogs",
    );
    // Four overview bullets — NOT the "Technology Applications" bullet that
    // follows, which the next-section header bounds out.
    expect(lines).toHaveLength(4);
    expect(overview).not.toContain("Development of 3-HKA");
  });

  it("sets hasPocData when a PoC Data bullet is present", () => {
    expect(parseOverview(page("", BULLET_BODY)).hasPocData).toBe(true);
  });

  // Real observed variants: a <br> inside the header <p>, and each bullet in its
  // own <ul> rather than one shared list.
  it("handles a <br>-prefixed header and bullets split across <ul> blocks", () => {
    const body = `<p><br><strong>Technology Overview</strong></p><ul><li><strong>The Technology:</strong> Small molecule inhibitors</li></ul><ul><li><strong>PoC Data:</strong> DIPQUO accelerated differentiation</li></ul><p><strong>Technology Advantages</strong></p><ul><li>Precision approach</li></ul>`;
    const { overview, hasPocData } = parseOverview(page("", body));
    expect(overview).toBe(
      "The Technology: Small molecule inhibitors\nPoC Data: DIPQUO accelerated differentiation",
    );
    expect(hasPocData).toBe(true);
    expect(overview).not.toContain("Precision approach");
  });
});

describe("parseOverview — prose form", () => {
  it("returns the paragraph text with no PoC flag", () => {
    const { overview, hasPocData } = parseOverview(page("", PROSE_BODY));
    expect(overview).toContain("Nieman-Pick type C disease");
    expect(overview).toContain("inside late endosomes/lysosomes");
    expect(hasPocData).toBe(false);
  });

  // A trailing <ul> after prose is a citation list, not overview bullets.
  it("stops prose at a trailing citation <ul>", () => {
    const body = `<p><strong>Technology Overview</strong></p><p>Approximately 70 million CT studies are performed each year in the US.</p><ul><li>Automated framework for dose reporting. AJR Am J Roentgenol., 2011</li></ul>`;
    const { overview } = parseOverview(page("", body));
    expect(overview).toBe("Approximately 70 million CT studies are performed each year in the US.");
    expect(overview).not.toContain("Roentgenol");
  });

  // Real CTL shape (MALT1, ML-network pages): the section after the prose is an
  // <h3 class="pane-title"> pane header (Publications, then Resources), NOT a
  // <p><strong>. The Publications citations are paragraphs, and the first <ul>
  // belongs to a later Resources download list. Without an <h3> boundary the
  // region ran to that <ul> and swallowed both sections' text.
  it("stops prose at an <h3 class=\"pane-title\"> section header", () => {
    const body =
      "<p><strong>Technology Overview</strong></p>" +
      "<p>MALT1 is a protease that activates NF-kB pathways in B cell lymphomas. (D-7251)</p>" +
      '<div class="panel-pane pane-node-field-technology-publications">' +
      '<h3 class="pane-title">Publications</h3>' +
      "<p>Fontan et al. J Clin Invest. 2018.</p></div>" +
      '<div class="panel-pane"><h3 class="pane-title">Resources</h3>' +
      '<ul><li><a href="d7251.pdf">Tech Brief.pdf</a></li></ul></div>';
    const { overview } = parseOverview(page("", body));
    expect(overview).toBe(
      "MALT1 is a protease that activates NF-kB pathways in B cell lymphomas. (D-7251)",
    );
    expect(overview).not.toContain("Publications");
    expect(overview).not.toContain("Fontan");
    expect(overview).not.toContain("Resources");
  });
});

describe("parseOverview — negatives", () => {
  // The trap: "Technology Overview" sits in the <meta description> on 103 pages
  // that carry NO body section. A body-wide text match would fabricate an
  // overview for ~40% of the portfolio; scoping to the body defeats it.
  it("ignores a Technology Overview that lives only in the meta description", () => {
    const head =
      '<meta name="description" content="Technology OverviewSerine is an essential amino acid required for performing numerous functions in the cell.">';
    const body = '<div class="field-content-items"><p>Some unrelated body copy.</p></div>';
    expect(parseOverview(page(head, body))).toEqual({ overview: null, hasPocData: false });
  });

  it("returns null when the page has no overview section at all", () => {
    const body = '<div class="field-content-items"><p><strong>Patents</strong></p><ul><li>Issued</li></ul></div>';
    expect(parseOverview(page("", body))).toEqual({ overview: null, hasPocData: false });
  });
});

describe("parseOverview — control bytes", () => {
  it("strips control bytes but keeps the bullet newlines", () => {
    // A NUL between two bullets — build it at runtime, never a literal byte in
    // source (#1602). It must not survive into the overview text.
    const nul = String.fromCharCode(0);
    const body = `<p><strong>Technology Overview</strong></p><ul><li>First ${nul}bullet</li><li>Second bullet</li></ul><p><strong>Technology Applications</strong></p>`;
    const { overview } = parseOverview(page("", body));
    expect(overview).toBe("First bullet\nSecond bullet");
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(overview!)).toBe(false);
  });
});
