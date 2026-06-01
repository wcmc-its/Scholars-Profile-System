import { describe, it, expect } from "vitest";

import {
  citedUrlsFromSources,
  findCitationPlacement,
  wilsonInterval,
  basketSha,
  aggregateSamples,
  detectVersionMismatches,
  estimateLlmCost,
  type CitedUrl,
  type LlmSample,
  type LlmRankSnapshot,
  type LlmRunMeta,
} from "@/lib/seo/llm-rank";
import type { BasketTarget } from "@/lib/seo/rank-basket";

const wcm: BasketTarget = {
  key: "new",
  label: "Scholars (new)",
  hosts: ["scholars.weill.cornell.edu"],
};
const penn: BasketTarget = {
  key: "penn",
  label: "Penn",
  hosts: ["www.med.upenn.edu"],
  pathPrefix: "/apps/faculty/",
};

describe("citedUrlsFromSources", () => {
  it("keeps url sources in order, dropping non-url and url-less entries", () => {
    const out = citedUrlsFromSources([
      { sourceType: "url", url: "https://a.com", title: "A" },
      { sourceType: "document", url: "file://nope" }, // non-url kind → dropped
      { type: "url", url: "https://b.com" }, // alternate field name
      { sourceType: "url" }, // no url → dropped
    ]);
    expect(out).toEqual([
      { url: "https://a.com", title: "A" },
      { url: "https://b.com", title: null },
    ]);
  });

  it("tolerates undefined and an empty kind (treats missing kind as a url)", () => {
    expect(citedUrlsFromSources(undefined)).toEqual([]);
    expect(citedUrlsFromSources([{ url: "https://c.com" }])).toEqual([
      { url: "https://c.com", title: null },
    ]);
  });
});

describe("findCitationPlacement", () => {
  const cited: CitedUrl[] = [
    { url: "https://www.mayoclinic.org/x", title: null },
    { url: "https://scholars.weill.cornell.edu/jane", title: "Jane" },
    { url: "https://scholars.weill.cornell.edu/joe", title: "Joe" },
  ];

  it("returns the lowest 1-based citation index where a target host matches", () => {
    const p = findCitationPlacement(cited, "scholars.weill.cornell.edu");
    expect(p.citationIndex).toBe(2);
    expect(p.url).toBe("https://scholars.weill.cornell.edu/jane");
    expect(p.title).toBe("Jane");
  });

  it("returns null when the target is not cited, or the list is empty", () => {
    expect(findCitationPlacement(cited, "example.org").citationIndex).toBeNull();
    expect(findCitationPlacement([], "scholars.weill.cornell.edu").citationIndex).toBeNull();
    expect(findCitationPlacement(undefined, "scholars.weill.cornell.edu").citationIndex).toBeNull();
  });

  it("honors host aliases and pathPrefix", () => {
    const list: CitedUrl[] = [
      { url: "https://www.med.upenn.edu/news", title: null },
      { url: "https://www.med.upenn.edu/apps/faculty/jane", title: null },
    ];
    expect(findCitationPlacement(list, penn.hosts, penn.pathPrefix).citationIndex).toBe(2);
    expect(
      findCitationPlacement(
        [{ url: "https://vivo.med.cornell.edu/x", title: null }],
        ["vivo.weill.cornell.edu", "vivo.med.cornell.edu"],
      ).citationIndex,
    ).toBe(1);
  });
});

describe("wilsonInterval", () => {
  it("returns all-zero for n=0 (no evidence)", () => {
    expect(wilsonInterval(0, 0)).toEqual({ rate: 0, lower: 0, upper: 0 });
  });

  it("keeps bounds inside [0,1] at the extremes", () => {
    const allHit = wilsonInterval(3, 3);
    expect(allHit.rate).toBe(1);
    expect(allHit.upper).toBe(1);
    expect(allHit.lower).toBeGreaterThan(0);
    expect(allHit.lower).toBeLessThan(1);

    const allMiss = wilsonInterval(0, 3);
    expect(allMiss.rate).toBe(0);
    expect(allMiss.lower).toBe(0);
    expect(allMiss.upper).toBeGreaterThan(0);
    expect(allMiss.upper).toBeLessThan(1);
  });

  it("computes a known interval (2/3 ≈ 0.667)", () => {
    const w = wilsonInterval(2, 3);
    expect(w.rate).toBeCloseTo(0.6667, 3);
    expect(w.lower).toBeGreaterThan(0.2);
    expect(w.lower).toBeLessThan(w.rate);
    expect(w.upper).toBeGreaterThan(w.rate);
    expect(w.upper).toBeLessThanOrEqual(1);
  });
});

describe("basketSha", () => {
  it("is deterministic and order-sensitive", () => {
    const a = [{ query: "cancer genomics expert" }, { query: "leukemia researcher" }];
    const b = [{ query: "leukemia researcher" }, { query: "cancer genomics expert" }];
    expect(basketSha(a)).toBe(basketSha(a));
    expect(basketSha(a)).not.toBe(basketSha(b)); // reorder → different basket
    expect(basketSha(a)).toHaveLength(12);
  });

  it("changes when a query changes", () => {
    const a = [{ query: "cancer genomics expert" }];
    const c = [{ query: "cancer genomics specialist" }];
    expect(basketSha(a)).not.toBe(basketSha(c));
  });
});

describe("aggregateSamples", () => {
  const targets = [wcm, penn];
  const mkSample = (idx: number, wcmIndex: number | null): LlmSample => ({
    sampleIndex: idx,
    citedUrls: [],
    placements: [
      { targetKey: "new", citationIndex: wcmIndex, url: null, title: null },
      { targetKey: "penn", citationIndex: null, url: null, title: null },
    ],
  });

  it("rolls N samples into a per-target rate, CI, and median citation index", () => {
    // WCM cited in 2 of 3 samples at indices 1 and 3 → median 2
    const samples = [mkSample(0, 1), mkSample(1, null), mkSample(2, 3)];
    const row = aggregateSamples("flagship:x", "x expert", "X", "perplexity", targets, samples);
    const wcmRate = row.perTarget.find((t) => t.targetKey === "new")!;
    expect(wcmRate.citedCount).toBe(2);
    expect(wcmRate.samples).toBe(3);
    expect(wcmRate.rate).toBeCloseTo(0.6667, 3);
    expect(wcmRate.medianCitationIndex).toBe(2);

    const pennRate = row.perTarget.find((t) => t.targetKey === "penn")!;
    expect(pennRate.citedCount).toBe(0);
    expect(pennRate.rate).toBe(0);
    expect(pennRate.medianCitationIndex).toBeNull();
    expect(row.rawSamples).toHaveLength(3);
  });
});

describe("detectVersionMismatches", () => {
  const run = (over: Partial<LlmRunMeta> = {}): LlmRunMeta => ({
    provider: "perplexity",
    model: "perplexity/sonar",
    modelDate: "2026-01-01",
    temperature: 0,
    samples: 3,
    queryBasketSha: "abc123",
    surface: "citation-rag",
    ...over,
  });
  const snap = (runs: LlmRunMeta[]): LlmRankSnapshot => ({
    capturedAt: "2026-06-01T00:00:00.000Z",
    basketSource: "data/seo/flagship-queries.json",
    targets: [wcm],
    runs,
    rows: [],
  });

  it("returns nothing when pins match", () => {
    expect(detectVersionMismatches(snap([run()]), snap([run()]))).toEqual([]);
  });

  it("flags (does not throw on) each differing field for a shared provider", () => {
    const before = snap([run()]);
    const after = snap([run({ model: "perplexity/sonar-pro", queryBasketSha: "def456" })]);
    const flags = detectVersionMismatches(before, after);
    const fields = flags.map((f) => f.field).sort();
    expect(fields).toEqual(["model", "queryBasketSha"]);
    expect(flags.find((f) => f.field === "model")).toMatchObject({
      provider: "perplexity",
      before: "perplexity/sonar",
      after: "perplexity/sonar-pro",
    });
  });

  it("ignores providers present in only one snapshot (incomparable, not a mismatch)", () => {
    const before = snap([run()]);
    const after = snap([run({ provider: "openai", model: "openai/gpt-5.1" })]);
    expect(detectVersionMismatches(before, after)).toEqual([]);
  });
});

describe("estimateLlmCost", () => {
  it("uses queries × providers × samples — NOT one-call-per-query", () => {
    const est = estimateLlmCost(
      24,
      [
        { key: "perplexity", costPerCallUsd: 0.005 },
        { key: "openai", costPerCallUsd: 0.01 },
        { key: "google", costPerCallUsd: 0.035 },
      ],
      3,
    );
    expect(est.totalCalls).toBe(24 * 3 * 3); // 216
    const perp = est.perProvider.find((p) => p.key === "perplexity")!;
    expect(perp.calls).toBe(24 * 3); // 72
    expect(perp.costUsd).toBeCloseTo(72 * 0.005, 6);
    expect(est.totalCostUsd).toBeCloseTo(72 * (0.005 + 0.01 + 0.035), 6);
  });
});
