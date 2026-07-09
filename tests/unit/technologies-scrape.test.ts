/**
 * Scraper parsing + listing pagination, against fixture HTML shaped like CTL's
 * Drupal markup. No network: `listingPaths`/`scrapePortfolio` take an injected
 * fetcher.
 *
 * These cover the two ways the scrape can go wrong without throwing: a detail
 * page whose PI has no VIVO link (attribution gap — must yield no row, not a
 * bad row), and a pager that never terminates.
 */
import { describe, expect, it } from "vitest";

import { listingPaths, parseDetail, scrapePortfolio } from "@/etl/technologies/scrape";

const detail = (opts: { title: string; ref?: string; pi: string; cwid?: string }) => `
<html><head><title>${opts.title} | Enterprise Innovation</title></head><body>
<div class="panel-pane pane-entity-field">
  <div class="field-label">Principal Investigator:&nbsp;</div>
  <div class="field-content-items"><p>${
    opts.cwid
      ? `<a href="https://vivo.weill.cornell.edu/display/cwid-${opts.cwid}">${opts.pi}</a>`
      : opts.pi
  }</p></div>
</div>
<div class="panel-pane pane-node-body"><div class="field-content-items">
${opts.ref ? `<p><strong>Cornell Reference</strong></p><ul><li>${opts.ref}</li></ul>` : ""}
</div></div></body></html>`;

const P1 = "/industry-investors-partners/technology-portfolio/alpha-tech";
const P2 = "/industry-investors-partners/technology-portfolio/beta-tech";

describe("parseDetail", () => {
  it("extracts cwid, reference, title, and absolute url", () => {
    const rows = parseDetail(
      P1,
      detail({ title: "Alpha Tech", ref: "11166", pi: "Zhen Zhao", cwid: "zhz9010" }),
    );
    expect(rows).toEqual([
      {
        cwid: "zhz9010",
        reference: "11166",
        title: "Alpha Tech",
        url: "https://innovation.weill.cornell.edu" + P1,
      },
    ]);
  });

  it("yields NO row when the PI carries no VIVO link (departed faculty)", () => {
    expect(parseDetail(P1, detail({ title: "Alpha", pi: "Lewis Cantley" }))).toEqual([]);
  });

  it("returns null reference when the page omits Cornell Reference", () => {
    const [r] = parseDetail(P1, detail({ title: "Alpha", pi: "X", cwid: "abc1234" }));
    expect(r.reference).toBeNull();
  });

  it("lowercases a legacy letter-only cwid", () => {
    const [r] = parseDetail(P1, detail({ title: "Alpha", pi: "Fischman", cwid: "FISCH" }));
    expect(r.cwid).toBe("fisch");
  });

  it("accepts the legacy vivo.med host", () => {
    const html = detail({ title: "Alpha", pi: "X", cwid: "lud2005" }).replace(
      "vivo.weill.cornell.edu",
      "vivo.med.cornell.edu",
    );
    expect(parseDetail(P1, html)[0].cwid).toBe("lud2005");
  });

  it("emits one row per PI on a multi-PI page", () => {
    const html = `
      <title>Multi | Enterprise Innovation</title>
      <div class="field-label">Principal Investigator:&nbsp;</div>
      <div class="field-content-items">
        <p><a href="https://vivo.weill.cornell.edu/display/cwid-aaa1111">A</a></p>
        <p><a href="https://vivo.weill.cornell.edu/display/cwid-bbb2222">B</a></p>
      </div>
      <div class="panel-pane">`;
    expect(
      parseDetail(P1, html)
        .map((r) => r.cwid)
        .sort(),
    ).toEqual(["aaa1111", "bbb2222"]);
  });

  it("decodes HTML entities in the title", () => {
    const [r] = parseDetail(
      P1,
      detail({ title: "Anti-CD3 &amp; Anti-CD28", pi: "X", cwid: "abc1234" }),
    );
    expect(r.title).toBe("Anti-CD3 & Anti-CD28");
  });
});

describe("listingPaths", () => {
  it("stops when a page contributes nothing new (Drupal repeats the last page)", async () => {
    const seen: string[] = [];
    const get = async (url: string) => {
      seen.push(url);
      // page=0 has P1, page=1 has P2, page>=2 repeats page 1.
      const page = Number(new URL(url).searchParams.get("page"));
      return page === 0 ? `<a href="${P1}">` : `<a href="${P2}">`;
    };
    expect(await listingPaths(get)).toEqual([P1, P2].sort());
    // 0, 1, then 2 which adds nothing → stop. Not an infinite pager walk.
    expect(seen).toHaveLength(3);
  });
});

describe("scrapePortfolio", () => {
  const get = async (url: string) => {
    if (url.includes("?page=0")) return `<a href="${P1}"><a href="${P2}">`;
    if (url.includes("?page=")) return "";
    if (url.endsWith(P1)) return detail({ title: "Alpha", ref: "1", pi: "Z", cwid: "zzz9999" });
    if (url.endsWith(P2)) return detail({ title: "Beta", pi: "Departed" }); // no cwid
    return null;
  };

  it("counts the attribution gap without failing", async () => {
    const r = await scrapePortfolio(get);
    expect(r.rows).toHaveLength(1);
    expect(r.pagesWithoutCwidLink).toBe(1);
    expect(r.pages).toBe(2);
  });

  it("throws rather than returning zero rows when no page carries a cwid", async () => {
    const noCwid = async (url: string) =>
      url.includes("?page=0")
        ? `<a href="${P1}">`
        : url.endsWith(P1)
          ? detail({ title: "A", pi: "D" })
          : "";
    await expect(scrapePortfolio(noCwid)).rejects.toThrow(/no page carried a VIVO cwid link/);
  });

  it("throws when the listing yields nothing", async () => {
    await expect(scrapePortfolio(async () => "")).rejects.toThrow(/listing yielded no pages/);
  });
});
