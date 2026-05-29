import { describe, it, expect } from "vitest";

import {
  normalizeHost,
  hostOf,
  hostMatches,
  findDomainRank,
  buildRequestParams,
  serpApiKeyFromEnv,
  type SerpOrganicResult,
} from "@/lib/seo/serpapi";
import {
  diffSnapshots,
  summarize,
  toCsv,
  type RankSnapshot,
} from "@/lib/seo/rank-basket";

describe("serpapi host matching", () => {
  it("normalizes case and strips www", () => {
    expect(normalizeHost("WWW.Scholars.Weill.Cornell.EDU")).toBe("scholars.weill.cornell.edu");
  });

  it("extracts host from a url, null on garbage", () => {
    expect(hostOf("https://scholars.weill.cornell.edu/scholars/jane-doe")).toBe(
      "scholars.weill.cornell.edu",
    );
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it("matches exact host and subdomains, with a dot boundary", () => {
    const t = "scholars.weill.cornell.edu";
    expect(hostMatches("https://scholars.weill.cornell.edu/x", t)).toBe(true);
    expect(hostMatches("https://www.scholars.weill.cornell.edu/x", t)).toBe(true);
    // suffix-collision must NOT match
    expect(hostMatches("https://notscholars.weill.cornell.edu/x", t)).toBe(false);
    // a different WCM subdomain must NOT match the scholars host
    expect(hostMatches("https://vivo.weill.cornell.edu/x", t)).toBe(false);
  });
});

describe("findDomainRank", () => {
  const results: SerpOrganicResult[] = [
    { position: 1, link: "https://en.wikipedia.org/wiki/Cancer", title: "Wikipedia" },
    { position: 2, link: "https://vivo.med.cornell.edu/display/cwid-abc", title: "VIVO old" },
    { position: 5, link: "https://scholars.weill.cornell.edu/scholars/jane", title: "Jane" },
    { position: 8, link: "https://scholars.weill.cornell.edu/topics/cancer", title: "Topic" },
  ];

  it("returns the best (lowest) position for the target", () => {
    expect(findDomainRank(results, "scholars.weill.cornell.edu")).toEqual({
      position: 5,
      url: "https://scholars.weill.cornell.edu/scholars/jane",
      title: "Jane",
    });
  });

  it("treats multiple hosts as aliases of one property", () => {
    expect(
      findDomainRank(results, ["vivo.weill.cornell.edu", "vivo.med.cornell.edu"]).position,
    ).toBe(2);
  });

  it("returns null placement when the domain is absent", () => {
    expect(findDomainRank(results, "example.com")).toEqual({
      position: null,
      url: null,
      title: null,
    });
  });

  it("tolerates undefined/empty result sets", () => {
    expect(findDomainRank(undefined, "x.com").position).toBeNull();
    expect(findDomainRank([], "x.com").position).toBeNull();
  });
});

describe("buildRequestParams", () => {
  it("includes engine, query, key and defaults", () => {
    const p = buildRequestParams("cancer genomics", "KEY123");
    expect(p.get("engine")).toBe("google");
    expect(p.get("q")).toBe("cancer genomics");
    expect(p.get("api_key")).toBe("KEY123");
    expect(p.get("gl")).toBe("us");
    expect(p.get("num")).toBe("20");
    expect(p.has("no_cache")).toBe(false);
  });

  it("honors overrides and no-cache", () => {
    const p = buildRequestParams("q", "K", { country: "gb", num: 30, noCache: true });
    expect(p.get("gl")).toBe("gb");
    expect(p.get("num")).toBe("30");
    expect(p.get("no_cache")).toBe("true");
  });
});

describe("serpApiKeyFromEnv", () => {
  it("returns the trimmed key", () => {
    expect(serpApiKeyFromEnv({ SERPAPI_KEY: " abc " })).toBe("abc");
  });
  it("throws a helpful error when unset", () => {
    expect(() => serpApiKeyFromEnv({})).toThrow(/SERPAPI_KEY is not set/);
  });
});

// ── snapshot diffing ────────────────────────────────────────────────────────

function snap(capturedAt: string, rows: RankSnapshot["rows"]): RankSnapshot {
  return {
    capturedAt,
    basketSource: "test",
    targets: [
      { key: "new", label: "Scholars (new)", hosts: ["scholars.weill.cornell.edu"] },
    ],
    rows,
  };
}

describe("diffSnapshots + summarize", () => {
  const before = snap("2026-01-01T00:00:00Z", [
    {
      id: "topic:a:plain",
      query: "a",
      type: "topical",
      topicId: "a",
      placements: [{ targetKey: "new", position: 12, url: null, title: null }],
    },
    {
      id: "topic:b:plain",
      query: "b",
      type: "topical",
      topicId: "b",
      placements: [{ targetKey: "new", position: 4, url: null, title: null }],
    },
    {
      id: "scholar:x",
      query: "x weill cornell",
      type: "branded",
      placements: [{ targetKey: "new", position: 1, url: null, title: null }],
    },
    {
      id: "topic:gone:plain",
      query: "gone",
      type: "topical",
      placements: [{ targetKey: "new", position: 3, url: null, title: null }],
    },
  ]);

  const after = snap("2026-06-01T00:00:00Z", [
    {
      id: "topic:a:plain", // 12 -> 7 : improved AND onto page 1
      query: "a",
      type: "topical",
      topicId: "a",
      placements: [{ targetKey: "new", position: 7, url: null, title: null }],
    },
    {
      id: "topic:b:plain", // 4 -> null : dropped out of window
      query: "b",
      type: "topical",
      topicId: "b",
      placements: [{ targetKey: "new", position: null, url: null, title: null }],
    },
    {
      id: "scholar:x", // 1 -> 1 : unchanged
      query: "x weill cornell",
      type: "branded",
      placements: [{ targetKey: "new", position: 1, url: null, title: null }],
    },
    {
      id: "topic:new:plain", // not in before — excluded from diff
      query: "new",
      type: "topical",
      placements: [{ targetKey: "new", position: 9, url: null, title: null }],
    },
  ]);

  const rows = diffSnapshots(before, after);

  it("joins on id and excludes queries missing from before", () => {
    const ids = rows.map((r) => r.id).sort();
    // topic:gone is in before-only (skipped); topic:new is after-only (skipped)
    expect(ids).toEqual(["scholar:x", "topic:a:plain", "topic:b:plain"]);
  });

  it("computes positive delta for improvements and classifies movement", () => {
    const a = rows.find((r) => r.id === "topic:a:plain")!;
    expect(a.delta).toBe(5); // 12 - 7
    expect(a.movement).toBe("improved");

    const b = rows.find((r) => r.id === "topic:b:plain")!;
    expect(b.delta).toBeNull();
    expect(b.movement).toBe("dropped");

    const x = rows.find((r) => r.id === "scholar:x")!;
    expect(x.movement).toBe("unchanged");
  });

  it("summarizes by target and type with comparable-set averages", () => {
    const summaries = summarize(rows);
    const topicalAll = summaries.find((s) => s.targetKey === "new" && s.type === "topical")!;
    // comparable set for topical = only topic:a (b dropped to null) → avg before 12, after 7
    expect(topicalAll.avgBefore).toBe(12);
    expect(topicalAll.avgAfter).toBe(7);
    expect(topicalAll.avgDelta).toBe(5);
    expect(topicalAll.ontoPageOne).toBe(1);
    expect(topicalAll.improved).toBe(1);
    expect(topicalAll.dropped).toBe(1);

    const all = summaries.find((s) => s.targetKey === "new" && s.type === "all")!;
    expect(all.count).toBe(3);
  });
});

describe("toCsv", () => {
  it("emits a header and escapes commas/quotes", () => {
    const csv = toCsv([
      {
        id: "topic:a:plain",
        query: 'cancer, genomics "test"',
        type: "topical",
        topicId: "a",
        label: "Cancer Genomics",
        targetKey: "new",
        beforePosition: 12,
        afterPosition: 7,
        delta: 5,
        movement: "improved",
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "id,type,topicId,label,query,target,beforePosition,afterPosition,delta,movement",
    );
    expect(lines[1]).toContain('"cancer, genomics ""test"""');
    expect(lines[1]).toContain(",improved");
  });
});
