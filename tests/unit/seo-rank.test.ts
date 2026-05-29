import { describe, it, expect } from "vitest";

import {
  normalizeHost,
  hostOf,
  hostMatches,
  pathMatches,
  findDomainRank,
  buildRequestParams,
  serpApiKeyFromEnv,
  throttleWaitMs,
  type SerpOrganicResult,
} from "@/lib/seo/serpapi";
import {
  diffSnapshots,
  summarize,
  toCsv,
  type RankSnapshot,
  type BasketTarget,
} from "@/lib/seo/rank-basket";
import {
  groupByInstitution,
  groupByPlatform,
  bestPlacement,
  computeStandings,
  headToHead,
  gapList,
  matchedCohorts,
} from "@/lib/seo/standings";
import {
  parseHIndex,
  pickBestAuthor,
  earliestYearFromWorks,
  academicAge,
  openAlexKey,
  institutionNamesOf,
  type OpenAlexAuthor,
} from "@/lib/seo/openalex";

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

describe("throttleWaitMs", () => {
  const HOUR = 3_600_000;
  const now = 1_000_000_000_000;

  it("returns 0 when the cap is disabled", () => {
    const times = Array.from({ length: 500 }, (_, i) => now - i * 1000);
    expect(throttleWaitMs(times, 0, now)).toBe(0);
    expect(throttleWaitMs(times, -1, now)).toBe(0);
  });

  it("returns 0 when under the cap (the common single-snapshot case)", () => {
    // 164 recent calls, cap 200 → free slot, no wait
    const times = Array.from({ length: 164 }, (_, i) => now - i * 1200);
    expect(throttleWaitMs(times, 200, now)).toBe(0);
  });

  it("ignores calls older than an hour", () => {
    // 200 calls but all >1h ago → window empty → no wait
    const times = Array.from({ length: 200 }, (_, i) => now - HOUR - 1000 - i * 1000);
    expect(throttleWaitMs(times, 200, now)).toBe(0);
  });

  it("waits until the oldest in-window call ages out when the window is full", () => {
    // Exactly `cap` calls in-window; oldest was 10 min ago → wait 50 min.
    const oldest = now - 10 * 60_000;
    const times = [oldest, ...Array.from({ length: 4 }, (_, i) => now - (i + 1) * 1000)];
    // cap = 5, window full → must wait until oldest + 1h
    expect(throttleWaitMs(times, 5, now)).toBe(oldest + HOUR - now);
  });

  it("frees a slot as soon as enough old calls have aged out", () => {
    // cap 3; calls at -90m, -50m, -40m, -30m. In-window: -50,-40,-30 (3 = full).
    const times = [now - 90 * 60_000, now - 50 * 60_000, now - 40 * 60_000, now - 30 * 60_000];
    // must wait until the -50m call ages out → 10 more minutes
    expect(throttleWaitMs(times, 3, now)).toBe(now - 50 * 60_000 + HOUR - now);
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

// ── pathPrefix scoping (Penn shares a host with non-profile pages) ─────────

describe("pathMatches + findDomainRank pathPrefix", () => {
  it("matches only paths under the prefix", () => {
    expect(pathMatches("https://www.med.upenn.edu/apps/faculty/p123", "/apps/faculty/")).toBe(true);
    expect(pathMatches("https://www.med.upenn.edu/news/story", "/apps/faculty/")).toBe(false);
    expect(pathMatches("https://x.edu/y", undefined)).toBe(true); // no prefix → host-level
    expect(pathMatches(null, "/apps/faculty/")).toBe(false);
  });

  it("scopes a shared host to its profile sub-path", () => {
    const results: SerpOrganicResult[] = [
      { position: 2, link: "https://www.med.upenn.edu/news/x", title: "News" },
      { position: 6, link: "https://www.med.upenn.edu/apps/faculty/p9", title: "Prof" },
    ];
    expect(findDomainRank(results, "med.upenn.edu", "/apps/faculty/").position).toBe(6);
    expect(findDomainRank(results, "med.upenn.edu").position).toBe(2); // no prefix
  });
});

// ── cross-sectional standings ─────────────────────────────────────────────

const RIVAL_TARGETS: BasketTarget[] = [
  { key: "wcm-new", label: "Scholars (new)", hosts: ["scholars.weill.cornell.edu"], institution: "WCM", platform: "custom", surfaceType: "research-profiles" },
  { key: "wcm-vivo", label: "VIVO (legacy)", hosts: ["vivo.weill.cornell.edu"], institution: "WCM", platform: "VIVO", surfaceType: "research-profiles" },
  { key: "wcm-clinical", label: "WCM clinical", hosts: ["weillcornell.org"], institution: "WCM", platform: "clinical", surfaceType: "clinical" },
  { key: "ucsf", label: "UCSF", hosts: ["profiles.ucsf.edu"], institution: "UCSF", platform: "Profiles RNS", surfaceType: "research-profiles" },
  { key: "hopkins", label: "Johns Hopkins", hosts: ["pure.johnshopkins.edu"], institution: "Johns Hopkins", platform: "Elsevier Pure", surfaceType: "research-profiles" },
  { key: "penn", label: "Penn", hosts: ["med.upenn.edu"], institution: "Penn", platform: "custom", surfaceType: "research-profiles", pathPrefix: "/apps/faculty/" },
];

function place(targetKey: string, position: number | null) {
  return { targetKey, position, url: position === null ? null : `https://x/${targetKey}`, title: null };
}

const rivalSnap: RankSnapshot = {
  capturedAt: "2026-05-29T00:00:00Z",
  basketSource: "test",
  targets: RIVAL_TARGETS,
  rows: [
    {
      id: "expert:breast_cancer:researcher",
      query: "breast cancer researcher",
      type: "expert",
      placements: [place("wcm-new", 8), place("wcm-vivo", null), place("ucsf", 3), place("hopkins", 5), place("penn", null)],
    },
    {
      id: "expert:cardiology:expert",
      query: "cardiology expert",
      type: "expert",
      placements: [place("wcm-new", 2), place("ucsf", 4), place("hopkins", 2), place("penn", null)],
    },
    {
      id: "expert:genomics:researcher",
      query: "genomics researcher",
      type: "expert",
      flagship: true,
      placements: [place("wcm-new", null), place("ucsf", null), place("hopkins", 6), place("penn", null)],
    },
    {
      id: "matched:cardiology:wcm",
      query: "Jane Smith",
      type: "branded",
      matchGroup: "cardiology",
      hIndex: 40,
      academicAge: 20,
      placements: [place("wcm-new", 1), place("ucsf", null)],
    },
    {
      id: "matched:cardiology:ucsf",
      query: "John Doe",
      type: "branded",
      matchGroup: "cardiology",
      hIndex: 38,
      academicAge: 22,
      placements: [place("ucsf", 1)],
    },
  ],
};

describe("grouping", () => {
  it("groups RP surfaces by institution and excludes clinical", () => {
    const insts = groupByInstitution(RIVAL_TARGETS, "research-profiles");
    const wcm = insts.find((g) => g.key === "WCM")!;
    expect(wcm.targetKeys.sort()).toEqual(["wcm-new", "wcm-vivo"]); // no clinical
    expect(insts.map((g) => g.key).sort()).toEqual(["Johns Hopkins", "Penn", "UCSF", "WCM"]);
  });

  it("includes clinical under WCM when surface=all", () => {
    const wcm = groupByInstitution(RIVAL_TARGETS, "all").find((g) => g.key === "WCM")!;
    expect(wcm.targetKeys).toContain("wcm-clinical");
  });

  it("groups by platform", () => {
    const plats = groupByPlatform(RIVAL_TARGETS, "research-profiles").map((g) => g.key).sort();
    expect(plats).toEqual(["Elsevier Pure", "Profiles RNS", "VIVO", "custom"]);
  });
});

describe("bestPlacement", () => {
  it("returns the lowest position across a group's targets", () => {
    const row = rivalSnap.rows[0];
    expect(bestPlacement(row, ["wcm-new", "wcm-vivo"]).position).toBe(8);
    expect(bestPlacement(row, ["wcm-vivo"]).position).toBeNull();
  });
});

describe("computeStandings", () => {
  const insts = groupByInstitution(RIVAL_TARGETS, "research-profiles");
  const standings = computeStandings(rivalSnap, insts, "expert");
  const get = (k: string) => standings.find((s) => s.key === k)!;

  it("counts appearance, top-k and median best per institution", () => {
    const wcm = get("WCM");
    expect(wcm.queries).toBe(3);
    expect(wcm.appeared).toBe(2); // 8, 2
    expect(wcm.top3).toBe(1); // 2
    expect(wcm.top10).toBe(2); // 8, 2
    expect(wcm.medianBest).toBe(5); // median(2,8)

    const hop = get("Johns Hopkins");
    expect(hop.appeared).toBe(3);
    expect(hop.medianBest).toBe(5); // median(2,5,6)
  });

  it("counts wins with shared ties and strict sole wins", () => {
    expect(get("UCSF").wins).toBe(1); // Q1 sole
    expect(get("UCSF").soleWins).toBe(1);
    expect(get("Johns Hopkins").wins).toBe(2); // Q2 tie + Q3 sole
    expect(get("Johns Hopkins").soleWins).toBe(1); // only Q3
    expect(get("WCM").wins).toBe(1); // Q2 tie
    expect(get("WCM").soleWins).toBe(0);
    expect(get("Penn").wins).toBe(0);
  });

  it("sorts by wins desc then median asc", () => {
    expect(standings.map((s) => s.key)).toEqual(["Johns Hopkins", "UCSF", "WCM", "Penn"]);
  });
});

describe("headToHead + gapList", () => {
  const insts = groupByInstitution(RIVAL_TARGETS, "research-profiles");
  const h2h = headToHead(rivalSnap, insts, "WCM", "expert");
  const get = (id: string) => h2h.find((r) => r.id === id)!;

  it("picks the best rival and classifies the winner", () => {
    expect(get("expert:breast_cancer:researcher").winner).toBe("rival"); // 8 vs UCSF 3
    expect(get("expert:cardiology:expert").winner).toBe("tie"); // 2 vs Hopkins 2
    expect(get("expert:genomics:researcher").winner).toBe("rival"); // null vs Hopkins 6
    expect(get("expert:cardiology:expert").home.targetKey).toBe("wcm-new");
  });

  it("flags queries where a rival is top-10 but WCM is not", () => {
    const gaps = gapList(rivalSnap, insts, "WCM", "expert").map((r) => r.id);
    expect(gaps).toEqual(["expert:genomics:researcher"]); // WCM absent, Hopkins @6
  });
});

describe("matchedCohorts", () => {
  it("groups matched name queries and attributes the ranking surface", () => {
    const insts = groupByInstitution(RIVAL_TARGETS, "research-profiles");
    const cohorts = matchedCohorts(rivalSnap, insts);
    expect(cohorts).toHaveLength(1);
    const c = cohorts[0];
    expect(c.matchGroup).toBe("cardiology");
    const wcm = c.entries.find((e) => e.institution === "WCM")!;
    expect(wcm.hIndex).toBe(40);
    expect(wcm.academicAge).toBe(20);
    expect(wcm.position).toBe(1);
    expect(wcm.targetKey).toBe("wcm-new");
    expect(c.entries.find((e) => e.institution === "UCSF")!.position).toBe(1);
  });
});

// ── OpenAlex pure parsers ─────────────────────────────────────────────────

describe("openalex parsers", () => {
  it("reads h-index from summary stats", () => {
    expect(parseHIndex({ id: "A1", display_name: "X", summary_stats: { h_index: 42 } })).toBe(42);
    expect(parseHIndex({ id: "A1", display_name: "X" })).toBeNull();
    expect(parseHIndex(null)).toBeNull();
  });

  it("derives earliest year and academic age", () => {
    expect(earliestYearFromWorks([{ publication_year: 2008 }, { publication_year: 2003 }, {}])).toBe(2003);
    expect(earliestYearFromWorks([])).toBeNull();
    expect(academicAge(2003, 2026)).toBe(23);
    expect(academicAge(null, 2026)).toBeNull();
    expect(academicAge(2030, 2026)).toBe(0); // never negative
  });

  it("normalizes openalex ids and institution names", () => {
    expect(openAlexKey("https://openalex.org/A5023888391")).toBe("A5023888391");
    expect(openAlexKey("A123")).toBe("A123");
    const a: OpenAlexAuthor = {
      id: "A1",
      display_name: "X",
      last_known_institutions: [{ id: "I1", display_name: "UCSF" }],
      affiliations: [{ institution: { id: "I1", display_name: "UCSF" } }],
    };
    expect(institutionNamesOf(a)).toEqual(["ucsf"]); // deduped, lowercased
  });

  it("picks the institution-matching author, else the most prolific", () => {
    const authors: OpenAlexAuthor[] = [
      { id: "A1", display_name: "Jane Smith", works_count: 200, last_known_institutions: [{ id: "I", display_name: "Stanford University" }] },
      { id: "A2", display_name: "Jane Smith", works_count: 50, last_known_institutions: [{ id: "I", display_name: "UCSF" }] },
    ];
    expect(pickBestAuthor(authors, { institution: "UCSF" })?.id).toBe("A2"); // institution wins over works
    expect(pickBestAuthor(authors)?.id).toBe("A1"); // no institution → most prolific
    expect(pickBestAuthor([])).toBeNull();
  });
});
