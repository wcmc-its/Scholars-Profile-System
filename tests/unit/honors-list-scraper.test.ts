/**
 * The honors-list scraper (etl/honors/lists/*): per-list parsers against small
 * synthetic fixtures (tests/fixtures/honors/, modelled on each roster's live
 * markup, every name invented), the conservative matcher, and the planning
 * rules that keep a scrape from ever overruling a curator.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { aaasPageUrl, parseAaasPage, scrapeAaas } from "@/etl/honors/lists/aaas";
import { parseBwfRoster } from "@/etl/honors/lists/bwf";
import { decodeEntities, HttpError, textOf } from "@/etl/honors/lists/html";
import { SCRAPERS } from "@/etl/honors/lists/index";
import {
  buildScholarIndex,
  isWcmAffiliation,
  matchEntry,
  MAX_CANDIDATES_PER_LINE,
  type RosterEntry,
  splitDisplayName,
  splitSortName,
} from "@/etl/honors/lists/match";
import { parseNaiRoster } from "@/etl/honors/lists/nai";
import { HONORS_SCRAPER_ACTOR, lineSourceRef, planList } from "@/etl/honors/lists/plan";
import { rosterKey, rosterMatchedName } from "@/lib/edit/honor-queue";
import { HONOR_LISTS, honorListById, selectHonorLists } from "@/lib/honors/lists";

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, "../fixtures/honors", name), "utf8");

const SCHOLARS = [
  { cwid: "zzq9001", preferredName: "Quentin Anvilworth", fullName: "Quentin Arlo Anvilworth" },
  { cwid: "zzq9002", preferredName: "Bea Brambleton", fullName: "Beatrix Lorna Brambleton" },
  { cwid: "zzq9003", preferredName: "Désirée Otéro-Vasquill", fullName: "Désirée Otéro-Vasquill" },
  { cwid: "zzq9004", preferredName: "Prudence Lanternhook", fullName: "Prudence Lanternhook" },
  { cwid: "zzq9005", preferredName: "Cornelius Quillfeather", fullName: "Cornelius Quillfeather" },
];
const INDEX = buildScholarIndex(SCHOLARS);

function entry(over: Partial<RosterEntry>): RosterEntry {
  return {
    printedName: "Quentin A. Anvilworth",
    given: "Quentin",
    family: "Anvilworth",
    affiliation: "Weill Cornell Medicine",
    year: 2020,
    ...over,
  };
}

describe("registry", () => {
  it("every list has a scraper, and every scraper a list", () => {
    expect(Object.keys(SCRAPERS).sort()).toEqual(HONOR_LISTS.map((l) => l.id).sort());
  });

  it("list metadata fits the honor columns it is written to", () => {
    for (const l of HONOR_LISTS) {
      expect(l.source.length).toBeLessThanOrEqual(32);
      expect(l.honorName.length).toBeLessThanOrEqual(255);
      expect(l.organization.length).toBeLessThanOrEqual(255);
      expect(new URL(l.rosterUrl).protocol).toBe("https:");
    }
    expect(HONORS_SCRAPER_ACTOR.length).toBeLessThanOrEqual(32);
  });

  it("selectHonorLists: all by default, a named subset, and an unknown id throws", () => {
    expect(selectHonorLists(undefined)).toHaveLength(HONOR_LISTS.length);
    expect(selectHonorLists("all")).toHaveLength(HONOR_LISTS.length);
    const one = HONOR_LISTS[1].id;
    expect(selectHonorLists(` ${one} ,${one}`).map((l) => l.id)).toEqual([one]);
    expect(() => selectHonorLists(`${one},not-a-list`)).toThrow(/not-a-list/);
    expect(honorListById("not-a-list")).toBeUndefined();
  });
});

describe("html helpers", () => {
  it("decodes named and numeric entities and drops hidden text", () => {
    expect(decodeEntities("A &amp; B &#233; &#xE9; &nbsp;x")).toBe("A & B é é  x");
    expect(textOf('<span style="display: none">Star Badge</span><a> Jane </a>')).toBe("Jane");
  });
});

describe("parsers (synthetic fixtures)", () => {
  it("NAI: name, institution, class year and the VIVO cwid link", () => {
    const rows = parseNaiRoster(fixture("nai-fellows.html"));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      printedName: "Quentin A. Anvilworth",
      given: "quentin",
      family: "anvilworth",
      affiliation: "Weill Cornell Medicine",
      year: 2019,
      cwidHint: null,
    });
    // The hidden "Star Badge" text is not part of the name.
    expect(rows[1]).toMatchObject({ printedName: "Beatrix L. Brambleton", cwidHint: "zzq9002" });
    expect(rows[3].printedName).toBe("Désirée Otéro-Vasquill");
  });

  it("BWF: the year comes from each section title; degrees are not part of the name", () => {
    const rows = parseBwfRoster(fixture("bwf-cams.html"));
    expect(rows.map((r) => [r.printedName, r.year, r.affiliation])).toEqual([
      ["Quentin A. Anvilworth, MD, PhD", 2020, "Weill Cornell Medical College"],
      ["Ophelia Nightjar, MD", 2020, "Invented State University"],
      ["Prudence Lanternhook, M.D., Ph.D.", 2015, "Weill Medical College of Cornell University"],
    ]);
    expect(rows[2]).toMatchObject({ given: "prudence", family: "lanternhook" });
  });

  it("AAAS: cells are read by field class, and 'Last, First' is split", () => {
    const rows = parseAaasPage(fixture("aaas-page.html"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      printedName: "Anvilworth, Quentin A",
      given: "quentin",
      family: "anvilworth",
      year: 2012,
      affiliation: "Weilll Cornell Medical College",
    });
    expect(rows[1].affiliation).toBe("Weill Institute for Cell & Molecular Bio");
  });

  it("a page with no roster markup parses to nothing rather than throwing", () => {
    expect(parseNaiRoster("<html>moved</html>")).toEqual([]);
    expect(parseBwfRoster("<html>moved</html>")).toEqual([]);
    expect(parseAaasPage("<html>moved</html>")).toEqual([]);
  });
});

describe("AAAS walk", () => {
  const page = fixture("aaas-page.html");
  const empty = "<table><tbody></tbody></table>";

  it("walks each institution search until an empty page, de-duplicating across searches", async () => {
    const seen: string[] = [];
    const out = await scrapeAaas(async (url) => {
      seen.push(url);
      return new URL(url).searchParams.get("page") ? empty : page;
    });
    expect(seen).toEqual([
      aaasPageUrl("Cornell", 0),
      aaasPageUrl("Cornell", 1),
      aaasPageUrl("Weill", 0),
      aaasPageUrl("Weill", 1),
    ]);
    expect(out.entries).toHaveLength(3);
    expect(out.complete).toBe(true);
  });

  it("stops on a pager that ignores page= (no new rows)", async () => {
    let calls = 0;
    await scrapeAaas(async () => (calls++, page));
    expect(calls).toBe(4); // page 0 + one repeat, per search term
  });

  it("a failure after the first page is PARTIAL; on the first page it fails the list", async () => {
    const partial = await scrapeAaas(async (url) => {
      if (new URL(url).searchParams.get("page") === "1") throw new HttpError(503, url);
      return new URL(url).searchParams.get("page") ? empty : page;
    });
    expect(partial.complete).toBe(false);
    expect(partial.warning).toMatch(/HTTP 503/);
    await expect(
      scrapeAaas(async (url) => {
        throw new HttpError(403, url);
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("matcher — conservative gates", () => {
  it("affiliation: Weill Cornell and its former names pass; Ithaca does not", () => {
    for (const a of [
      "Weill Cornell Medicine",
      "Weill Medical College of Cornell University",
      "Weilll Cornell Medical College",
      "Cornell University Medical College",
      "New York Hospital-Cornell Medical Center",
    ])
      expect(isWcmAffiliation(a), a).toBe(true);
    for (const a of [
      "Cornell University",
      "Cornell Univ",
      "Weill Institute for Cell & Molecular Bio",
      "",
      null,
    ])
      expect(isWcmAffiliation(a), String(a)).toBe(false);
  });

  it("names: first + last, degrees and titles dropped, 'Last, First' handled", () => {
    expect(splitDisplayName("Dr. Jane Q. Doe, MD, PhD")).toEqual({ given: "jane", family: "doe" });
    expect(splitDisplayName("Jane Doe Jr.")).toEqual({ given: "jane", family: "doe" });
    expect(splitSortName("Doe, Jane Q")).toEqual({ given: "jane", family: "doe" });
    expect(splitDisplayName("Doe")).toBeNull();
  });

  it("a full first name + surname at WCM is ONE candidate, with evidence", () => {
    expect(matchEntry(entry({}), INDEX)).toEqual([
      { cwid: "zzq9001", evidence: "Name and institution match: listed at Weill Cornell Medicine" },
    ]);
  });

  it("matches on the preferred OR the full name, and folds accents", () => {
    expect(matchEntry(entry({ given: "Beatrix", family: "Brambleton" }), INDEX)).toHaveLength(1);
    expect(matchEntry(entry({ given: "Bea", family: "Brambleton" }), INDEX)).toHaveLength(1);
    expect(matchEntry(entry({ given: "Desiree", family: "Otero-Vasquill" }), INDEX)[0].cwid).toBe(
      "zzq9003",
    );
  });

  it("misses rather than guesses: wrong institution, an initial, a different first name", () => {
    expect(matchEntry(entry({ affiliation: "Cornell University" }), INDEX)).toEqual([]);
    expect(matchEntry(entry({ affiliation: null }), INDEX)).toEqual([]);
    expect(matchEntry(entry({ given: "Q" }), INDEX)).toEqual([]);
    expect(matchEntry(entry({ given: "Quincy" }), INDEX)).toEqual([]);
  });

  it("a VIVO link on the roster names the scholar outright, even without the institution", () => {
    expect(
      matchEntry(
        entry({ given: "Nobody", family: "Else", affiliation: null, cwidHint: "zzq9002" }),
        INDEX,
      ),
    ).toEqual([{ cwid: "zzq9002", evidence: "Roster links this scholar's Weill Cornell profile" }]);
    // A hint for a cwid we do not have falls back to the ordinary gates.
    expect(matchEntry(entry({ cwidHint: "zzq0000" }), INDEX)).toHaveLength(1);
  });

  it("two same-name scholars are both candidates (a contested line); too many is dropped", () => {
    const twins = buildScholarIndex([
      ...SCHOLARS,
      { cwid: "zzq9101", preferredName: "Quentin Anvilworth", fullName: "Quentin B Anvilworth" },
    ]);
    expect(matchEntry(entry({}), twins).map((c) => c.cwid)).toEqual(["zzq9001", "zzq9101"]);
    const crowd = buildScholarIndex(
      Array.from({ length: MAX_CANDIDATES_PER_LINE + 1 }, (_, i) => ({
        cwid: `zzq95${i}`,
        preferredName: "Quentin Anvilworth",
        fullName: "Quentin Anvilworth",
      })),
    );
    expect(matchEntry(entry({}), crowd)).toEqual([]);
  });
});

describe("planList — a scrape never overrules a curator", () => {
  const META = HONOR_LISTS[0];
  const scrape = (entries: RosterEntry[]) => ({ entries, complete: true, warning: null });

  it("a new match becomes ONE pending row, keyed to its roster line", () => {
    const plan = planList(
      META,
      scrape([entry({}), entry({ printedName: "Nobody", given: "No", family: "Body" })]),
      INDEX,
      [],
    );
    expect(plan).toMatchObject({ onListTotal: 2, matched: 1, evidenceFills: [] });
    expect(plan.creates).toEqual([
      {
        cwid: "zzq9001",
        category: META.category,
        name: META.honorName,
        organization: META.organization,
        year: 2020,
        status: "pending",
        showOnProfile: true,
        source: META.source,
        sourceRef: `${META.rosterUrl}|Quentin A. Anvilworth|2020`,
        enteredByCwid: HONORS_SCRAPER_ACTOR,
        evidence: "Name and institution match: listed at Weill Cornell Medicine",
      },
    ]);
    // The queue reads the line back exactly as the seed wrote it.
    expect(rosterMatchedName(plan.creates[0].sourceRef)).toBe("Quentin A. Anvilworth");
    expect(rosterKey(plan.creates[0].sourceRef)).toBe(META.rosterUrl);
  });

  it("never re-proposes a rejected, published or pending honor", () => {
    for (const status of ["rejected", "published", "pending"] as const) {
      const plan = planList(META, scrape([entry({})]), INDEX, [
        { id: "h1", cwid: "zzq9001", status, evidence: "already" },
      ]);
      expect(plan.creates, status).toEqual([]);
      expect(plan.evidenceFills, status).toEqual([]);
      expect(plan.matched).toBe(1);
    }
  });

  it("fills a missing evidence line on a still-pending row only", () => {
    const pending = planList(META, scrape([entry({})]), INDEX, [
      { id: "h1", cwid: "zzq9001", status: "pending", evidence: null },
    ]);
    expect(pending.evidenceFills).toEqual([
      { id: "h1", evidence: "Name and institution match: listed at Weill Cornell Medicine" },
    ]);
    const rejected = planList(META, scrape([entry({})]), INDEX, [
      { id: "h1", cwid: "zzq9001", status: "rejected", evidence: null },
    ]);
    expect(rejected.evidenceFills).toEqual([]);
  });

  it("a contested line shares one sourceRef; a line one candidate already holds proposes nobody", () => {
    const twins = buildScholarIndex([
      ...SCHOLARS,
      { cwid: "zzq9101", preferredName: "Quentin Anvilworth", fullName: "Quentin Anvilworth" },
    ]);
    const open = planList(META, scrape([entry({})]), twins, []);
    expect(open.creates.map((c) => c.cwid)).toEqual(["zzq9001", "zzq9101"]);
    expect(new Set(open.creates.map((c) => c.sourceRef)).size).toBe(1);
    const claimed = planList(META, scrape([entry({})]), twins, [
      { id: "h1", cwid: "zzq9001", status: "published", evidence: null },
    ]);
    expect(claimed.creates).toEqual([]);
  });

  it("a scholar listed twice is proposed once", () => {
    const plan = planList(META, scrape([entry({ year: 2019 }), entry({ year: 2021 })]), INDEX, []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.matched).toBe(2);
  });

  it("lineSourceRef keeps the 3-part shape even when the printed name has a pipe", () => {
    const ref = lineSourceRef(META, "A | B", null);
    expect(ref.split("|")).toHaveLength(3);
    expect(ref.endsWith("|")).toBe(true);
  });
});
