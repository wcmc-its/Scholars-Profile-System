/** Report 9: the awards defaults, the year basis, the people summary, the
 *  shortened byline, the chips, the reset test and the download note. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { read: {}, write: {} } }));

import { SCHOLAR_EXPORT_CAP } from "@/lib/api/export-scholars";
import {
  authorSegments,
  describeHighImpactCriteria,
  HIGH_IMPACT_LIST_CAP,
  highImpactChips,
  highImpactDownloadNote,
  highImpactQueryString,
  isHighImpactDefault,
  JOURNAL_FAMILIES,
  parseHighImpactParams,
  summarizePeople,
  type HighImpactRow,
} from "@/lib/edit/high-impact-pubs-report";

describe("parseHighImpactParams", () => {
  const year = new Date().getFullYear();

  it("a bare URL gets the awards defaults: FT faculty, original research, first or last author, this year, every journal", () => {
    const p = parseHighImpactParams(new URLSearchParams());
    expect(p).toMatchObject({
      types: ["full_time_faculty"],
      atypes: ["Academic Article"],
      pos: "either",
      basis: "cy",
      from: year,
      to: year,
      view: "summary",
    });
    expect(p.journals).toEqual(JOURNAL_FAMILIES.map((f) => f.key));
    // `view` alone is still a bare URL.
    expect(parseHighImpactParams(new URLSearchParams("view=publications"))).toMatchObject({
      types: ["full_time_faculty"],
      view: "publications",
    });
  });

  it("a submitted form is taken as-is; unknown journals are dropped; none left → every family", () => {
    const p = parseHighImpactParams(new URLSearchParams("pos=any&from=2024&to=2025&journal=nejm&journal=bogus"));
    expect(p).toMatchObject({ types: [], atypes: [], pos: "any", from: 2024, to: 2025, journals: ["nejm"] });
    expect(parseHighImpactParams(new URLSearchParams("pos=any&journal=bogus")).journals).toHaveLength(
      JOURNAL_FAMILIES.length,
    );
  });

  it("the query string round-trips through the parser, on either year basis", () => {
    const p = parseHighImpactParams(new URLSearchParams());
    expect(parseHighImpactParams(new URLSearchParams(highImpactQueryString(p, "publications")))).toEqual({
      ...p,
      view: "publications",
    });
    const fy = parseHighImpactParams(new URLSearchParams("basis=fy&from=2025&to=2026&pos=first"));
    expect(fy).toMatchObject({ basis: "fy", from: 2025, to: 2026 });
    expect(parseHighImpactParams(new URLSearchParams(highImpactQueryString(fy)))).toEqual(fy);
  });

  it("links made before the fiscal option keep their meaning: no basis = calendar, and calendar adds no param", () => {
    const old = parseHighImpactParams(new URLSearchParams("type=full_time_faculty&pos=either&from=2025&to=2025"));
    expect(old.basis).toBe("cy");
    expect(new URLSearchParams(highImpactQueryString(old)).has("basis")).toBe(false);
    // A minimum impact factor belongs to report 8: ignored here, never emitted.
    expect(parseHighImpactParams(new URLSearchParams("pos=any&jif=20")).jif).toBe(0);
    expect(new URLSearchParams(highImpactQueryString(old)).has("jif")).toBe(false);
  });

  it("isHighImpactDefault: the bare URL is the default; any changed filter is not", () => {
    expect(isHighImpactDefault(parseHighImpactParams(new URLSearchParams("view=publications")))).toBe(true);
    const d = parseHighImpactParams(new URLSearchParams());
    expect(isHighImpactDefault(parseHighImpactParams(new URLSearchParams(highImpactQueryString(d))))).toBe(true);
    expect(isHighImpactDefault({ ...d, pos: "any" })).toBe(false);
    expect(isHighImpactDefault({ ...d, basis: "fy" })).toBe(false);
    expect(isHighImpactDefault({ ...d, journals: ["nejm"] })).toBe(false);
    expect(isHighImpactDefault({ ...d, units: ["dept:MED"] })).toBe(false);
  });
});

describe("summarizePeople", () => {
  const person = (cwid: string, position: "first" | "last" | "middle") => ({
    cwid,
    name: cwid.toUpperCase(),
    department: "Medicine",
    personType: "Full-time faculty",
    position,
  });
  const article = (pmid: string, journal: string, citations: number | null, people: ReturnType<typeof person>[]) =>
    ({ pmid, journal, citations, people }) as unknown as HighImpactRow;

  it("one row per person: articles, first/last counts, citations, journals by frequency; most articles first", () => {
    const rows = summarizePeople([
      article("1", "Nature", 10, [person("aaa", "first"), person("bbb", "last")]),
      article("2", "JAMA", null, [person("bbb", "first")]),
      article("3", "JAMA", 5, [person("bbb", "last")]),
    ]);
    expect(rows.map((r) => r.cwid)).toEqual(["bbb", "aaa"]);
    expect(rows[0]).toMatchObject({ articles: 3, firstAuthor: 1, lastAuthor: 2, citations: 15, journals: ["JAMA", "Nature"] });
    // Each person's own articles and position, for the page's expanded row.
    expect(rows[0].pubs).toEqual([
      { pmid: "1", position: "last" },
      { pmid: "2", position: "first" },
      { pmid: "3", position: "last" },
    ]);
    expect(rows[1]).toMatchObject({ articles: 1, firstAuthor: 1, lastAuthor: 0, citations: 10, journals: ["Nature"] });
  });

  it("a person listed twice on one article counts that article once", () => {
    const [row] = summarizePeople([article("1", "Cell", 2, [person("aaa", "first"), person("aaa", "last")])]);
    expect(row).toMatchObject({ articles: 1, firstAuthor: 1, lastAuthor: 1, citations: 2 });
    expect(row.pubs).toEqual([{ pmid: "1", position: "first" }]);
  });
});

describe("authorSegments", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `Author${i + 1} A`);

  it("a short byline is kept whole, the matching authors marked", () => {
    expect(authorSegments(names(3), new Set([1]))).toEqual([
      { text: "Author1 A" },
      { text: "Author2 A", wcm: true },
      { text: "Author3 A" },
    ]);
  });

  it("a long byline keeps the first three, every matching author and the last, with gaps between", () => {
    const out = authorSegments(names(400), new Set([199]));
    expect(out.map((s) => s.text)).toEqual(["Author1 A", "Author2 A", "Author3 A", "…", "Author200 A", "…", "Author400 A"]);
    expect(out.filter((s) => s.wcm).map((s) => s.text)).toEqual(["Author200 A"]);
    expect(out.filter((s) => s.gap)).toHaveLength(2);
  });

  it("an out-of-range rank is ignored; adjacent kept authors get no gap", () => {
    const out = authorSegments(names(12), new Set([3, 99]));
    expect(out.map((s) => s.text)).toEqual(["Author1 A", "Author2 A", "Author3 A", "Author4 A", "…", "Author12 A"]);
  });
});

describe("highImpactChips", () => {
  const labels = new Map([
    ["dept:MED", "Medicine"],
    ["center:CC", "Cancer Center"],
  ]);
  const q = (s: string | null) => (s === null ? null : parseHighImpactParams(new URLSearchParams(s)));

  it("the defaults: years and all journals unremovable; person type, article type and position removable", () => {
    const chips = highImpactChips(parseHighImpactParams(new URLSearchParams()));
    const year = String(new Date().getFullYear());
    expect(chips.map((c) => [c.group, c.value, c.removeQuery !== null])).toEqual([
      ["Years", year, false],
      ["Journals", `All ${JOURNAL_FAMILIES.length} top-tier families`, false],
      ["Person type", "Full-time faculty", true],
      ["Article type", "Academic Article", true],
      ["Author", "First or last author", true],
    ]);
  });

  it("removing a chip drops only that value and never yields a bare URL (the defaults would come back)", () => {
    const p = parseHighImpactParams(
      new URLSearchParams("unit=dept:MED&unit=center:CC&pos=first&from=2024&to=2026&basis=fy&journal=nejm"),
    );
    const chips = highImpactChips(p, labels);
    const by = (g: string) => chips.find((c) => c.group === g)!;
    expect(by("Years").value).toBe("FY2024–FY2026");
    expect(by("Department / division").value).toBe("Medicine");
    expect(q(by("Department / division").removeQuery)).toMatchObject({ units: ["center:CC"], pos: "first", basis: "fy" });
    expect(q(by("Centers").removeQuery)).toMatchObject({ units: ["dept:MED"] });
    // The last journal family removed → every family (none checked = all).
    expect(q(by("Journals").removeQuery)!.journals).toHaveLength(JOURNAL_FAMILIES.length);
    expect(q(by("Author").removeQuery)).toMatchObject({ pos: "any", units: ["dept:MED", "center:CC"] });
    for (const c of chips) if (c.removeQuery !== null) expect(c.removeQuery).toContain("from=2024");
  });

  it("more than three values collapse to one \"N selected\" chip that clears the facet", () => {
    const p = parseHighImpactParams(
      new URLSearchParams("pos=any&atype=A&atype=B&atype=C&atype=D&journal=jama&journal=nejm"),
    );
    const chips = highImpactChips(p);
    const at = chips.filter((c) => c.group === "Article type");
    expect(at).toEqual([{ group: "Article type", value: "4 selected", removeQuery: expect.any(String) }]);
    expect(q(at[0].removeQuery)!.atypes).toEqual([]);
    expect(chips.filter((c) => c.group === "Journals").map((c) => c.value)).toEqual([
      "JAMA (all JAMA journals)",
      "NEJM (all NEJM journals)",
    ]);
    expect(chips.some((c) => c.group === "Author")).toBe(false);
  });
});

describe("highImpactDownloadNote", () => {
  it("all three sheets within the caps", () => {
    expect(highImpactDownloadNote({ articles: 10, scholars: SCHOLAR_EXPORT_CAP })).toEqual({
      text: "Includes the Criteria, People and Publications sheets.",
      withheld: false,
    });
  });

  it("above the scholar export cap the People sheet is withheld, and the note says why", () => {
    const n = highImpactDownloadNote({ articles: 86, scholars: SCHOLAR_EXPORT_CAP + 19 });
    expect(n.withheld).toBe(true);
    expect(n.text).toContain(`left out above ${SCHOLAR_EXPORT_CAP} people (${SCHOLAR_EXPORT_CAP + 19} match)`);
  });

  it("above the list cap only the Criteria sheet is left", () => {
    const n = highImpactDownloadNote({ articles: HIGH_IMPACT_LIST_CAP + 1, scholars: 3 });
    expect(n.withheld).toBe(true);
    expect(n.text).toMatch(/^Includes the Criteria sheet only/);
  });
});

describe("describeHighImpactCriteria", () => {
  it("names the report, the journals and the year basis; no impact-factor row", () => {
    const rows = new Map(
      describeHighImpactCriteria(
        parseHighImpactParams(new URLSearchParams("basis=fy&pos=any&journal=cell")),
        new Date("2026-09-24T00:00:00Z"),
      ),
    );
    expect(rows.get("Report")).toBe("9. Top clinical and high-impact journal publications");
    expect(rows.get("Journals")).toBe("Cell");
    expect(rows.get("Year basis")).toMatch(/^Fiscal year/);
    expect(rows.has("Minimum Journal Impact Factor")).toBe(false);
  });
});
