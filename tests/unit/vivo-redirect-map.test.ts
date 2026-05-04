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
