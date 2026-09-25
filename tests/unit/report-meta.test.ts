/**
 * `lib/edit/report-meta.ts` — the editable report metadata loader. Protects:
 * a report with no row renders its hardcoded default (every `ReportKey` is
 * present either way; only report 7 has a default description — the former
 * "Sources" disclosure); a present row wins ENTIRELY, a stored NULL
 * description included (so a superuser can clear 7's default); `isReportKey`
 * accepts exactly the eight string keys (never the number, never "");
 * `reportLabel` is `"N. Name"`; `reportPageMetadata` is the console `<title>`
 * pattern with noindex. `@/lib/db` is mocked at the module boundary — this
 * suite asserts the merge, not Prisma. The migration stays DDL-only (#584,
 * `migrations-empty-db-safe.test.ts`), which is why the defaults, not a seed,
 * are the source of the initial text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ mockFindMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { read: { reportMeta: { findMany: h.mockFindMany } }, write: {} },
}));

import {
  isReportKey,
  isValidReportSlug,
  loadReportMeta,
  REPORT_KEYS,
  REPORT_META_DEFAULTS,
  reportLabel,
  reportMetaFor,
  reportPageMetadata,
} from "@/lib/edit/report-meta";
import { sanitizeOverviewHtml } from "@/lib/edit/validators";

beforeEach(() => {
  vi.clearAllMocks();
  h.mockFindMany.mockResolvedValue([]);
});

describe("loadReportMeta", () => {
  it("an empty table → every key present, each at its hardcoded default", async () => {
    const meta = await loadReportMeta();
    expect([...meta.keys()]).toEqual([...REPORT_KEYS]);
    for (const key of REPORT_KEYS) {
      expect(meta.get(key)).toEqual({ key, ...REPORT_META_DEFAULTS[key] });
    }
    expect(h.mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("only report 7 has a default description — the former Sources disclosure, on the overview allowlist", async () => {
    const meta = await loadReportMeta();
    for (const key of ["1", "2", "3", "4", "5", "6"] as const) {
      expect(meta.get(key)!.descriptionHtml).toBeNull();
    }
    const seven = meta.get("7")!.descriptionHtml!;
    for (const label of [
      "MD",
      "MD-PhD (program office)",
      "ECR",
      "PhD / MD-PhD thesis advisor",
      "Postdoc supervisor",
      "Likely mentee (from co-authorship)",
      "Possible mentee (from co-authorship)",
      "Faculty-asserted",
    ]) {
      expect(seven).toContain(`<strong>${label}</strong>`);
    }
    expect(seven).toContain("Not yet a source: the Faculty Review Tool");
    // Only allowlisted tags — the same set the sanitizer keeps — and already
    // clean: the read-path re-sanitize (`ReportHeader`) is a no-op on it.
    const tags = new Set([...seven.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(["li", "p", "strong", "ul"]);
    expect(sanitizeOverviewHtml(seven)).toBe(seven);
  });

  it("a present row wins ENTIRELY: a stored NULL description clears report 7's default", async () => {
    h.mockFindMany.mockResolvedValue([
      {
        reportKey: "7",
        slug: "mentored-publications",
        name: "Mentored publications",
        summary: "S",
        descriptionHtml: null,
      },
    ]);
    const meta = await loadReportMeta();
    expect(meta.get("7")!.descriptionHtml).toBeNull();
  });

  it("a present row wins over the default; a missing row falls back", async () => {
    h.mockFindMany.mockResolvedValue([
      {
        reportKey: "3",
        slug: "papers",
        name: "Papers",
        summary: "Renamed blurb.",
        descriptionHtml: "<p>About.</p>",
      },
    ]);
    const meta = await loadReportMeta();
    expect(meta.get("3")).toEqual({
      key: "3",
      slug: "papers",
      name: "Papers",
      summary: "Renamed blurb.",
      descriptionHtml: "<p>About.</p>",
    });
    expect(meta.get("4")).toEqual({
      key: "4",
      slug: "grants",
      name: "Grants",
      summary: REPORT_META_DEFAULTS["4"].summary,
      descriptionHtml: null,
    });
    expect(meta.size).toBe(9);
  });

  it("a row the catalog doesn't know is ignored, not added", async () => {
    h.mockFindMany.mockResolvedValue([
      { reportKey: "99", name: "X", summary: "Y", descriptionHtml: null },
    ]);
    const meta = await loadReportMeta();
    expect(meta.size).toBe(9);
    expect(meta.has("99" as never)).toBe(false);
  });

  it("reportMetaFor narrows to one key", async () => {
    h.mockFindMany.mockResolvedValue([
      { reportKey: "7", name: "Mentees", summary: "S", descriptionHtml: null },
    ]);
    expect(await reportMetaFor("7")).toMatchObject({ key: "7", name: "Mentees" });
    expect(await reportMetaFor("1")).toMatchObject({ key: "1", name: "Optimize membership" });
  });
});

describe("isReportKey", () => {
  it.each(["1", "2", "3", "4", "5", "6", "7"])("accepts %j", (v) => {
    expect(isReportKey(v)).toBe(true);
  });
  it.each(["10", "0", "", 7, null, undefined, "1 ", ["1"]])("rejects %j", (v) => {
    expect(isReportKey(v)).toBe(false);
  });
});

describe("isValidReportSlug", () => {
  it.each(["publications", "nci-table-2a", "a", "x1-2y", "a".repeat(64)])("accepts %j", (v) => {
    expect(isValidReportSlug(v)).toBe(true);
  });
  it.each([
    "",
    "Publications",
    "a--b",
    "-a",
    "a-",
    "a b",
    "a_b",
    "7",
    "007",
    "a".repeat(65),
    3,
    null,
  ])("rejects %j", (v) => {
    expect(isValidReportSlug(v)).toBe(false);
  });
  it("every default slug is valid and unique — the digit namespace stays free for the stable key", () => {
    const slugs = REPORT_KEYS.map((k) => REPORT_META_DEFAULTS[k].slug);
    for (const slug of slugs) expect(isValidReportSlug(slug)).toBe(true);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
  it("report 5's default summary matches its scope: PIs only, every OnCore status", () => {
    const { summary } = REPORT_META_DEFAULTS["5"];
    expect(summary).not.toMatch(/^Active/);
    expect(summary).toMatch(/principal investigator/);
    expect(summary).toMatch(/every OnCore status/);
  });
});

describe("reportLabel / reportPageMetadata", () => {
  it("reportLabel is the numbered index label", () => {
    expect(reportLabel({ key: "3", name: "Publications" })).toBe("3. Publications");
    expect(reportLabel({ key: "7", name: "Mentored publications" })).toBe(
      "7. Mentored publications",
    );
  });

  it("reportPageMetadata is the console <title> pattern, noindex, off the loaded name", async () => {
    h.mockFindMany.mockResolvedValue([
      { reportKey: "2", name: "Table 2A", summary: "S", descriptionHtml: null },
    ]);
    expect(await reportPageMetadata("2")).toEqual({
      title: "Table 2A — Scholars Console",
      robots: { index: false, follow: false },
    });
    expect(await reportPageMetadata("5")).toEqual({
      title: "Clinical Trials — Scholars Console",
      robots: { index: false, follow: false },
    });
  });
});
