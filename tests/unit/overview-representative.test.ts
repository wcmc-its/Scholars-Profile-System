import { describe, expect, it } from "vitest";

import {
  rankRepresentativePublications,
  type RepresentativeCandidate,
} from "@/lib/edit/overview-representative";

/** Compact candidate factory — only the fields a test cares about. */
function cand(p: Partial<RepresentativeCandidate> & { pmid: string }): RepresentativeCandidate {
  return {
    impact: 50,
    year: 2020,
    authorPosition: "first",
    topicAreaId: null,
    clusterKey: null,
    ...p,
  };
}

const NOW = 2026;

describe("rankRepresentativePublications — empty + shape", () => {
  it("returns [] for no candidates", () => {
    expect(rankRepresentativePublications([])).toEqual([]);
  });

  it("returns every candidate, ranked 0..n-1, with a featured flag and a reason", () => {
    const out = rankRepresentativePublications(
      [cand({ pmid: "a" }), cand({ pmid: "b", impact: 10 })],
      { nowYear: NOW },
    );
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.rank)).toEqual([0, 1]);
    expect(out.every((r) => typeof r.reason === "string" && r.reason.length > 0)).toBe(true);
    expect(out.every((r) => typeof r.featured === "boolean")).toBe(true);
  });
});

describe("Stage 1 — scoring order", () => {
  it("ranks a high-impact, recent, senior-author paper above a low-impact, old, middle-author one", () => {
    const out = rankRepresentativePublications(
      [
        cand({ pmid: "weak", impact: 5, year: 2005, authorPosition: "middle" }),
        cand({ pmid: "strong", impact: 95, year: 2025, authorPosition: "first" }),
      ],
      { nowYear: NOW },
    );
    expect(out[0].pmid).toBe("strong");
    expect(out[1].pmid).toBe("weak");
  });

  it("down-weights middle-author work relative to first/last at equal impact + year", () => {
    const out = rankRepresentativePublications(
      [
        cand({ pmid: "middle", authorPosition: "middle", impact: 50, year: 2024 }),
        cand({ pmid: "led", authorPosition: "last", impact: 50, year: 2024 }),
      ],
      { nowYear: NOW },
    );
    expect(out[0].pmid).toBe("led");
    const led = out.find((r) => r.pmid === "led")!;
    const middle = out.find((r) => r.pmid === "middle")!;
    expect(led.score).toBeGreaterThan(middle.score);
  });

  it("applies only a gentle recency decay — a strong older paper beats a weak new one", () => {
    const out = rankRepresentativePublications(
      [
        cand({ pmid: "old-strong", impact: 80, year: 2014, authorPosition: "first" }),
        cand({ pmid: "new-weak", impact: 20, year: 2026, authorPosition: "middle" }),
      ],
      { nowYear: NOW, landmarkQuantile: 1.1 /* disable landmark to isolate decay */ },
    );
    expect(out[0].pmid).toBe("old-strong");
  });
});

describe("landmark floor + guarantee", () => {
  it("pins a top-quantile old paper above a recent minor paper (recency never sinks a landmark)", () => {
    const corpus = [
      cand({ pmid: "landmark", impact: 100, year: 2010, authorPosition: "first" }),
      ...Array.from({ length: 8 }, (_, i) =>
        cand({ pmid: `minor-${i}`, impact: 10 + i, year: 2025, authorPosition: "middle" }),
      ),
    ];
    const out = rankRepresentativePublications(corpus, { nowYear: NOW });
    expect(out[0].pmid).toBe("landmark");
    expect(out.find((r) => r.pmid === "landmark")!.isLandmark).toBe(true);
  });

  it("guarantees a landmark is featured even when its area is already at the cap", () => {
    const corpus = [
      // Area A already saturated by two strong recent papers.
      cand({ pmid: "a1", impact: 90, year: 2025, topicAreaId: "A" }),
      cand({ pmid: "a2", impact: 88, year: 2025, topicAreaId: "A" }),
      // A landmark also in area A — must still be featured despite the area cap.
      cand({ pmid: "a-landmark", impact: 100, year: 2012, topicAreaId: "A" }),
      // Filler so the distribution has a real top quantile.
      ...Array.from({ length: 6 }, (_, i) =>
        cand({ pmid: `f${i}`, impact: 20 + i, year: 2019, topicAreaId: "B" }),
      ),
    ];
    const out = rankRepresentativePublications(corpus, {
      nowYear: NOW,
      maxPerArea: 2,
      featuredLimit: 12,
    });
    const lm = out.find((r) => r.pmid === "a-landmark")!;
    expect(lm.isLandmark).toBe(true);
    expect(lm.featured).toBe(true);
  });

  it("never calls a lone scored paper a landmark", () => {
    const out = rankRepresentativePublications([cand({ pmid: "solo", impact: 100 })], {
      nowYear: NOW,
    });
    expect(out[0].isLandmark).toBe(false);
  });
});

describe("Stage 2 — coverage pass (topic spread)", () => {
  it("defers a 3rd same-area paper to the Available tail in favor of a fresh area", () => {
    const corpus = [
      cand({ pmid: "A1", impact: 90, year: 2025, topicAreaId: "A" }),
      cand({ pmid: "A2", impact: 85, year: 2025, topicAreaId: "A" }),
      cand({ pmid: "A3", impact: 80, year: 2025, topicAreaId: "A" }),
      cand({ pmid: "B1", impact: 40, year: 2024, topicAreaId: "B" }),
    ];
    const out = rankRepresentativePublications(corpus, {
      nowYear: NOW,
      maxPerArea: 2,
      featuredLimit: 3,
      landmarkQuantile: 1.1, // isolate the spread logic from the landmark guarantee
    });
    const featured = new Set(out.filter((r) => r.featured).map((r) => r.pmid));
    expect(featured.has("A1")).toBe(true);
    expect(featured.has("A2")).toBe(true);
    // A3 is the 3rd in area A (cap 2) → deferred even though it outscores B1.
    expect(featured.has("A3")).toBe(false);
    expect(featured.has("B1")).toBe(true);
  });
});

describe("Stage 2 — near-duplicate dedup", () => {
  it("features one paper per cluster; the duplicate stays in the Available tail", () => {
    const corpus = [
      cand({ pmid: "main", impact: 90, year: 2025, clusterKey: "AEGIS-II" }),
      cand({ pmid: "companion", impact: 88, year: 2025, clusterKey: "AEGIS-II" }),
      cand({ pmid: "other", impact: 50, year: 2024, clusterKey: "X" }),
    ];
    const out = rankRepresentativePublications(corpus, {
      nowYear: NOW,
      featuredLimit: 12,
      landmarkQuantile: 1.1,
    });
    const featured = new Set(out.filter((r) => r.featured).map((r) => r.pmid));
    expect(featured.has("main")).toBe(true);
    expect(featured.has("companion")).toBe(false);
    expect(featured.has("other")).toBe(true);
  });
});

describe("tiers + featuredLimit + reasons", () => {
  it("assigns core/supporting/minor across the impact distribution", () => {
    const corpus = Array.from({ length: 10 }, (_, i) =>
      cand({ pmid: `p${i}`, impact: i * 10, year: 2020 }),
    );
    const out = rankRepresentativePublications(corpus, { nowYear: NOW });
    const tierByPmid = new Map(out.map((r) => [r.pmid, r.tier]));
    expect(tierByPmid.get("p9")).toBe("core"); // top impact
    expect(tierByPmid.get("p0")).toBe("minor"); // bottom impact
    expect(new Set(out.map((r) => r.tier)).size).toBeGreaterThan(1);
  });

  it("never features more than featuredLimit", () => {
    const corpus = Array.from({ length: 30 }, (_, i) =>
      cand({ pmid: `p${i}`, impact: 30 + i, year: 2020, topicAreaId: `area-${i}` }),
    );
    const out = rankRepresentativePublications(corpus, { nowYear: NOW, featuredLimit: 8 });
    expect(out.filter((r) => r.featured)).toHaveLength(8);
  });

  it("emits numberless reasons (no digits) and a landmark-specific phrase", () => {
    const corpus = [
      cand({ pmid: "lm", impact: 100, year: 2012, authorPosition: "first" }),
      ...Array.from({ length: 5 }, (_, i) => cand({ pmid: `x${i}`, impact: 10 + i, year: 2026 })),
    ];
    const out = rankRepresentativePublications(corpus, { nowYear: NOW });
    expect(out.find((r) => r.pmid === "lm")!.reason).toMatch(/landmark/i);
    expect(out.every((r) => !/\d/.test(r.reason))).toBe(true);
  });

  it("is deterministic — equal scores break ties by year then pmid", () => {
    const a = rankRepresentativePublications(
      [cand({ pmid: "b" }), cand({ pmid: "a" })],
      { nowYear: NOW },
    );
    const b = rankRepresentativePublications(
      [cand({ pmid: "a" }), cand({ pmid: "b" })],
      { nowYear: NOW },
    );
    expect(a.map((r) => r.pmid)).toEqual(b.map((r) => r.pmid));
    expect(a[0].pmid).toBe("a"); // tie → pmid asc
  });

  it("treats null-impact papers as minor and never landmark", () => {
    const out = rankRepresentativePublications(
      [cand({ pmid: "n", impact: null }), cand({ pmid: "s", impact: 80 })],
      { nowYear: NOW },
    );
    const n = out.find((r) => r.pmid === "n")!;
    expect(n.tier).toBe("minor");
    expect(n.isLandmark).toBe(false);
  });
});
