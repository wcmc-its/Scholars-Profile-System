/**
 * #2209 — recovery of publication titles that ReCiterDB delivers BLANK.
 *
 * The upstream defect signature is a PubMed `<ArticleTitle>` carrying a
 * self-closing inline tag (`…extracellular NAD<sup/>.`); ReCiterDB's
 * `analysis_summary_article.articleTitle` comes back as an empty string, so the
 * publication row rendered as an empty, unlabeled line on the public profile.
 * PubMed still has the title, so `etl:reciter` recovers it from ESummary.
 */
import { describe, it, expect, vi } from "vitest";

import {
  fetchPubmedTitles,
  isBlankTitle,
  normalizeEsummaryTitle,
} from "@/etl/reciter/pubmed-titles";

describe("isBlankTitle", () => {
  it("treats null, empty and whitespace-only as blank", () => {
    expect(isBlankTitle(null)).toBe(true);
    expect(isBlankTitle(undefined)).toBe(true);
    expect(isBlankTitle("")).toBe(true);
    expect(isBlankTitle("   \n\t ")).toBe(true);
  });

  it("does NOT treat a real title as blank", () => {
    expect(isBlankTitle("CD38 is methylated in prostate cancer")).toBe(false);
    // A title that is nothing but markup is still "present" upstream; the
    // sanitizer/renderer handles it. Only textual emptiness triggers recovery.
    expect(isBlankTitle("0")).toBe(false);
  });
});

describe("normalizeEsummaryTitle", () => {
  it("drops the empty parens ESummary leaves where a void <sup/> was", () => {
    // The literal ESummary payload for PMID 30258629 on 2026-08-05.
    expect(
      normalizeEsummaryTitle(
        "CD38 is methylated in prostate cancer and regulates extracellular NAD().",
      ),
    ).toBe("CD38 is methylated in prostate cancer and regulates extracellular NAD.");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeEsummaryTitle("  A   two-line\n title ")).toBe("A two-line title");
  });

  it("returns null when nothing renderable survives", () => {
    expect(normalizeEsummaryTitle("")).toBeNull();
    expect(normalizeEsummaryTitle("   ")).toBeNull();
    expect(normalizeEsummaryTitle("()")).toBeNull();
    expect(normalizeEsummaryTitle(null)).toBeNull();
  });

  it("leaves a normal title untouched", () => {
    const t = "3D-rendered Electromechanical Wave Imaging for Localization of Accessory Pathways";
    expect(normalizeEsummaryTitle(t)).toBe(t);
  });
});

function esummaryResponse(docs: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { uids: Object.keys(docs), ...docs } }),
    text: async () => "",
  } as unknown as Response;
}

describe("fetchPubmedTitles", () => {
  it("returns the recovered title per pmid", async () => {
    const fetchFn = vi.fn(async () =>
      esummaryResponse({
        "30258629": { uid: "30258629", title: "CD38 is methylated in prostate cancer NAD()." },
        "31947257": { uid: "31947257", title: "3D-rendered Electromechanical Wave Imaging()." },
      }),
    );
    const out = await fetchPubmedTitles([31947257, 30258629], {
      fetchFn,
      delayMs: 0,
      retryBaseMs: 0,
    });
    expect(out.get(30258629)).toBe("CD38 is methylated in prostate cancer NAD.");
    expect(out.get(31947257)).toBe("3D-rendered Electromechanical Wave Imaging.");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("makes ZERO network calls when nothing is blank (a converged corpus)", async () => {
    const fetchFn = vi.fn(async () => esummaryResponse({}));
    expect((await fetchPubmedTitles([], { fetchFn, delayMs: 0, retryBaseMs: 0 })).size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never asks PubMed about a synthetic negative pmid (external-source pubs, #101)", async () => {
    const fetchFn = vi.fn(async () => esummaryResponse({}));
    const out = await fetchPubmedTitles([-42, -7], { fetchFn, delayMs: 0, retryBaseMs: 0 });
    expect(out.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("omits a pmid PubMed cannot name rather than mapping it to an empty title", async () => {
    const fetchFn = vi.fn(async () =>
      esummaryResponse({
        "1": { uid: "1", error: "cannot get document summary" },
        "2": { uid: "2", title: "   " },
        "3": { uid: "3", title: "A real title" },
      }),
    );
    const out = await fetchPubmedTitles([1, 2, 3], { fetchFn, delayMs: 0, retryBaseMs: 0 });
    expect([...out.keys()]).toEqual([3]);
  });

  it("de-duplicates and batches the id list", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(decodeURIComponent(String(url)));
      return esummaryResponse({});
    });
    await fetchPubmedTitles([5, 5, 5, 6], { fetchFn, delayMs: 0, retryBaseMs: 0 });
    expect(urls[0]).toContain("id=5,6");
  });

  it("caps recovery so an upstream regression cannot become a corpus-wide crawl", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(decodeURIComponent(String(url)));
      return esummaryResponse({});
    });
    await fetchPubmedTitles([1, 2, 3, 4, 5], {
      fetchFn,
      delayMs: 0,
      retryBaseMs: 0,
      maxRecover: 2,
    });
    expect(urls[0]).toContain("id=1,2");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("retries a 5xx, then succeeds", async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
          text: async () => "",
        } as unknown as Response;
      }
      return esummaryResponse({ "9": { uid: "9", title: "Recovered" } });
    });
    const out = await fetchPubmedTitles([9], { fetchFn, delayMs: 0, retryBaseMs: 0 });
    expect(out.get(9)).toBe("Recovered");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws when E-utilities stays down — the ETL caller catches and falls back", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ENOTFOUND eutils.ncbi.nlm.nih.gov");
    });
    await expect(fetchPubmedTitles([9], { fetchFn, delayMs: 0, retryBaseMs: 0 })).rejects.toThrow(
      "ENOTFOUND",
    );
  });
});
