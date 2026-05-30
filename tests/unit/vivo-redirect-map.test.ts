/**
 * RED unit tests for etl/vivo-redirect/generate-map.ts (Phase 5 / SEO-04).
 *
 * These tests define the contract that Plan 05 must satisfy. They FAIL now
 * because etl/vivo-redirect/generate-map.ts does not yet exist. That is the
 * expected RED state.
 *
 * Contract (D-05):
 *   - buildVivoMapLines(scholars, aliases, baseUrl) returns an array of strings
 *   - Output begins with comment lines (lines starting with '#')
 *   - Each scholar line: `{cwid}\t{baseUrl}/scholars/{slug};`
 *     (key = raw CWID, no 'cwid-' prefix; value = full scholars URL; trailing semicolon)
 *   - Active scholar produces one line keyed by cwid
 *   - cwid_aliases produce additional lines: oldCwid key → current scholar's slug URL
 *     (the alias resolves to the live cwid's current slug)
 *   - Deleted scholars (deletedAt non-null in the DB) produce zero lines
 *     (the mock here reflects only what the Prisma query returns — deleted scholars
 *      are excluded by WHERE deletedAt IS NULL AND status = 'active' in the ETL)
 *
 * Schema note: CwidAlias model has fields `oldCwid` and `currentCwid` (not `alias`/`cwid`).
 * The generate-map.ts function accepts pre-queried data so the field names here match
 * what Prisma returns from prisma.cwidAlias.findMany({ select: { oldCwid, currentCwid } }).
 *
 * nginx RewriteMap format reference (RESEARCH.md Pattern 8):
 *   # comment line
 *   ccole    https://scholars.weill.cornell.edu/scholars/christopher-cole;
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    scholar: { findMany: vi.fn() },
    cwidAlias: { findMany: vi.fn() },
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  process.env.NEXT_PUBLIC_SITE_URL = "https://scholars.weill.cornell.edu";
});

const BASE_URL = "https://scholars.weill.cornell.edu";

const ACTIVE_SCHOLARS = [
  { cwid: "ccole", slug: "christopher-cole" },
  { cwid: "jdoe", slug: "jane-doe" },
];

// Alias: old CWID 'ccole-old' maps to current cwid 'ccole' (which has slug 'christopher-cole')
const ALIASES = [
  { oldCwid: "ccole-old", currentCwid: "ccole" },
];

// Build a slug lookup for convenience in the alias resolution
const SLUG_BY_CWID = new Map(ACTIVE_SCHOLARS.map((s) => [s.cwid, s.slug]));

describe("buildVivoMapLines — nginx RewriteMap output (D-05)", () => {
  it("is importable from @/etl/vivo-redirect/generate-map (will fail until Plan 05 creates the file)", async () => {
    // Will fail with module-not-found until Plan 05 creates etl/vivo-redirect/generate-map.ts
    const mod = await import("@/etl/vivo-redirect/generate-map");
    expect(typeof mod.buildVivoMapLines).toBe("function");
  });

  it("returns an array of strings", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, [], BASE_URL);
    expect(Array.isArray(lines)).toBe(true);
  });

  it("output begins with comment lines starting with '#' (nginx map_hash_max_size documentation)", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, [], BASE_URL);
    const commentLines = lines.filter((l: string) => l.startsWith("#"));
    expect(commentLines.length).toBeGreaterThanOrEqual(1);
  });

  it("each data line ends with a semicolon (nginx map value delimiter)", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, [], BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines) {
      expect(line.trimEnd()).toMatch(/;$/);
    }
  });

  it("active scholar produces one line keyed by raw cwid (no 'cwid-' prefix)", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, [], BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    // ccole → https://scholars.weill.cornell.edu/scholars/christopher-cole;
    const coleLine = dataLines.find((l: string) => l.startsWith("ccole\t") || l.split(/\s+/)[0] === "ccole");
    expect(coleLine).toBeDefined();
    expect(coleLine).toContain("https://scholars.weill.cornell.edu/scholars/christopher-cole;");
  });

  it("line key is the raw cwid without 'cwid-' prefix", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, [], BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    for (const line of dataLines) {
      const key = line.split(/\s+/)[0];
      expect(key).not.toMatch(/^cwid-/);
    }
  });

  it("cwid_alias produces an additional line with oldCwid key → current scholar slug URL", async () => {
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines(ACTIVE_SCHOLARS, ALIASES, BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    // oldCwid 'ccole-old' → same slug URL as current cwid 'ccole'
    const aliasLine = dataLines.find(
      (l: string) => l.startsWith("ccole-old\t") || l.split(/\s+/)[0] === "ccole-old",
    );
    expect(aliasLine).toBeDefined();
    expect(aliasLine).toContain("https://scholars.weill.cornell.edu/scholars/christopher-cole;");
  });

  it("deleted scholars produce zero lines (DB filter excludes them before this function is called)", async () => {
    // The DB query only returns active scholars; this function receives the result.
    // An empty scholars array simulates the case where all scholars are deleted.
    const { buildVivoMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoMapLines([], [], BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    expect(dataLines.length).toBe(0);
  });
});

// ── D-06 / D-07: pubid<PMID> → owning WCM author's profile ────────────────────
// The query feeding these pure functions already filters to confirmed, active
// WCM authorships, so every PubAuthorRow here is a live profile (D-07's hard
// "active" gate). The functions only apply the priority and emit the map.
const row = (
  cwid: string,
  slug: string,
  position: number,
  opts: { isFirst?: boolean; isLast?: boolean } = {},
) => ({ cwid, slug, position, isFirst: !!opts.isFirst, isLast: !!opts.isLast });

describe("pickPubAuthorSlug — D-07 author priority (active first → senior → earliest rank)", () => {
  it("prefers the first author when present", async () => {
    const { pickPubAuthorSlug } = await import("@/etl/vivo-redirect/generate-map");
    const rows = [
      row("snr1", "senior-pi", 8, { isLast: true }),
      row("fst1", "first-author", 1, { isFirst: true }),
      row("mid1", "middle-author", 4),
    ];
    expect(pickPubAuthorSlug(rows)).toBe("first-author");
  });

  it("falls back to the senior (last) author when the first author isn't active", async () => {
    // First author absent from rows = not an active WCM author (filtered out upstream).
    const { pickPubAuthorSlug } = await import("@/etl/vivo-redirect/generate-map");
    const rows = [
      row("mid1", "middle-author", 4),
      row("snr1", "senior-pi", 8, { isLast: true }),
    ];
    expect(pickPubAuthorSlug(rows)).toBe("senior-pi");
  });

  it("falls back to the earliest remaining rank when neither first nor last is active", async () => {
    const { pickPubAuthorSlug } = await import("@/etl/vivo-redirect/generate-map");
    const rows = [
      row("mid3", "middle-three", 6),
      row("mid2", "middle-two", 3),
      row("mid4", "middle-four", 5),
    ];
    expect(pickPubAuthorSlug(rows)).toBe("middle-two"); // lowest position (3)
  });

  it("returns null for a PMID with no active WCM author (→ D-08 fall-through)", async () => {
    const { pickPubAuthorSlug } = await import("@/etl/vivo-redirect/generate-map");
    expect(pickPubAuthorSlug([])).toBeNull();
  });
});

describe("buildPubMapEntries + buildVivoPubMapLines — D-06 output", () => {
  it("emits one entry per PMID, keyed by the bare PMID, ';'-terminated", async () => {
    const { buildPubMapEntries, buildVivoPubMapLines } = await import(
      "@/etl/vivo-redirect/generate-map"
    );
    const byPmid = new Map([
      ["41036949", [row("fst1", "first-author", 1, { isFirst: true })]],
      ["37430076", [row("snr1", "senior-pi", 9, { isLast: true })]],
    ]);
    const entries = buildPubMapEntries(byPmid);
    expect(entries).toHaveLength(2);

    const lines = buildVivoPubMapLines(entries, BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    expect(dataLines).toContain(`41036949\t${BASE_URL}/scholars/first-author;`);
    expect(dataLines).toContain(`37430076\t${BASE_URL}/scholars/senior-pi;`);
    for (const line of dataLines) expect(line.trimEnd()).toMatch(/;$/);
  });

  it("drops PMIDs with no resolvable author (D-08) and starts with a '#' comment header", async () => {
    const { buildPubMapEntries, buildVivoPubMapLines } = await import(
      "@/etl/vivo-redirect/generate-map"
    );
    const byPmid = new Map([
      ["41036949", [row("fst1", "first-author", 1, { isFirst: true })]],
      ["99999999", []], // no active WCM author
    ]);
    const entries = buildPubMapEntries(byPmid);
    expect(entries.map((e) => e.pmid)).toEqual(["41036949"]);

    const lines = buildVivoPubMapLines(entries, BASE_URL);
    expect(lines.filter((l: string) => l.startsWith("#")).length).toBeGreaterThanOrEqual(1);
    const key = lines.find((l: string) => l.startsWith("41036949"))?.split(/\s+/)[0];
    expect(key).not.toMatch(/^pubid/); // bare PMID, no 'pubid' prefix
  });
});

// ── D-10..D-13: org-u<N> → /departments|/centers (hand-built crosswalk) ────────
describe("buildVivoOrgMapLines — D-10..D-13 org crosswalk output", () => {
  it("emits a line only for resolved targets, skipping nulls (D-13)", async () => {
    const { buildVivoOrgMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoOrgMapLines(
      [
        { vivoOrgId: "u18", scholarsTarget: "/departments/medicine" },
        { vivoOrgId: "u27", scholarsTarget: null }, // unresolved → 404 fall-through
        { vivoOrgId: "u34", scholarsTarget: "/centers/meyer-cancer-center" },
      ],
      BASE_URL,
    );
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    expect(dataLines).toContain(`u18\t${BASE_URL}/departments/medicine;`);
    expect(dataLines).toContain(`u34\t${BASE_URL}/centers/meyer-cancer-center;`);
    expect(dataLines.some((l: string) => l.startsWith("u27"))).toBe(false);
    for (const line of dataLines) expect(line.trimEnd()).toMatch(/;$/);
  });

  it("an all-null crosswalk yields zero data lines (empty map until resolved)", async () => {
    const { buildVivoOrgMapLines } = await import("@/etl/vivo-redirect/generate-map");
    const lines = buildVivoOrgMapLines([{ vivoOrgId: "u18", scholarsTarget: null }], BASE_URL);
    const dataLines = lines.filter((l: string) => !l.startsWith("#") && l.trim().length > 0);
    expect(dataLines.length).toBe(0);
  });
});
