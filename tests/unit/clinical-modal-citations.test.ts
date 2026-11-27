/** The publication modal's "Clinical studies" group: the flag gate, the pure
 *  shaping (lib/citations/trials-patents.ts), the paging bounds
 *  (lib/citations/clinical-page.ts), the read, and the public paged route.
 *  PMIDs, titles and journals are invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ publication: vi.fn(), links: vi.fn(), suppression: vi.fn() }));
vi.mock("@/lib/db", () => {
  const none = () => vi.fn(async () => []);
  return {
    prisma: {
      publication: { findUnique: h.publication },
      publicationCitingDocument: { findMany: h.links },
      subtopic: { findMany: none() },
      suppression: { findMany: h.suppression },
      publicationAuthor: { findMany: none() },
      scholarFamily: { findMany: none() },
      publicationCiting: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
      familySuppressionOverlay: { findMany: none() },
      familySensitivityOverlay: { findMany: none() },
      publicationCore: { findMany: none() },
      coreClaim: { findMany: none() },
      core: { findMany: none() },
    },
    db: { read: { coreClaim: { findMany: none() } } },
  };
});
vi.mock("@/lib/sources/reciterdb", () => ({
  withReciterConnection: vi.fn(async (fn: (conn: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => []) }),
  ),
}));

import { GET } from "@/app/api/publications/[pmid]/clinical-citations/[offset]/route";
import {
  getClinicalCitationsPage,
  getPublicationDetail,
  readClinicalCitations,
} from "@/lib/api/publication-detail";
import { CLINICAL_PAGE_SIZE, clinicalCitationsPath, parseClinicalOffset } from "@/lib/citations/clinical-page";
import {
  clinicalCitationsModalOn,
  shapeClinicalCitations,
  toClinicalStudy,
  type ClinicalLink,
} from "@/lib/citations/trials-patents";
import { OWN_WORK } from "@/etl/clinical-citations/shape";

function study(id: number, over: { own?: boolean; year?: number | null; url?: string } = {}): ClinicalLink {
  return {
    evidence: over.own ? { ...OWN_WORK } : null,
    citingDocument: {
      id,
      title: `Widget study ${id}`,
      year: over.year === undefined ? 2031 : over.year,
      url: over.url ?? `https://pubmed.ncbi.nlm.nih.gov/9${String(id).padStart(7, "0")}/`,
      journal: "Journal of Widget Medicine",
      journalAbbrev: "J Widget Med",
    },
  };
}

type FindArgs = {
  where: { pmid: string; citingDocument: { level: unknown } };
  skip?: number;
  take?: number;
  orderBy?: unknown;
};

/** A stand-in store holding `rows` as the clinical links of pmid 111, already in list order. */
function store(rows: ClinicalLink[]) {
  h.links.mockImplementation(async (args: FindArgs) => {
    if (args.where.pmid !== "111" || args.where.citingDocument.level !== "clinical") return [];
    if (args.take === undefined) return rows.map((r) => ({ evidence: r.evidence }));
    return rows.slice(args.skip ?? 0, (args.skip ?? 0) + args.take);
  });
}

const clinicalCalls = () =>
  h.links.mock.calls.map((c) => c[0] as FindArgs).filter((a) => a.where.citingDocument.level === "clinical");

const pub = {
  pmid: "111",
  title: "Test paper",
  journal: "J. Test",
  year: 2024,
  volume: "1",
  issue: "2",
  pages: "10-20",
  fullAuthorsString: "Example A, Sample B",
  abstract: "An abstract.",
  impactScore: 75,
  impactJustification: "Novel.",
  citationCount: 42,
  pmcid: null,
  doi: null,
  pubmedUrl: null,
  meshTerms: [],
  synopsis: null,
  publicationTopics: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLINICAL_CITATIONS_MODAL;
  delete process.env.TRIAL_CITATIONS_MODAL;
  delete process.env.PATENT_CITATIONS_MODAL;
  delete process.env.POLICY_CITATION_BADGES;
  h.publication.mockImplementation(async (args: { where: { pmid: string } }) =>
    args.where.pmid === "111" ? pub : null,
  );
  h.suppression.mockResolvedValue([]);
  h.links.mockImplementation(async () => []);
});

describe("clinicalCitationsModalOn", () => {
  it.each([
    ["on", true],
    ["off", false],
    ["true", false],
    ["ON", false],
    [undefined, false],
  ])("CLINICAL_CITATIONS_MODAL=%s reads %s", (value, on) => {
    if (value === undefined) delete process.env.CLINICAL_CITATIONS_MODAL;
    else process.env.CLINICAL_CITATIONS_MODAL = value;
    expect(clinicalCitationsModalOn()).toBe(on);
  });
});

describe("toClinicalStudy", () => {
  it("carries title, PubMed link, journal, year and the own-work mark", () => {
    expect(toClinicalStudy(study(7))).toEqual({
      id: 7,
      title: "Widget study 7",
      url: "https://pubmed.ncbi.nlm.nih.gov/90000007/",
      journal: "J Widget Med",
      year: 2031,
      ownWork: false,
    });
    expect(toClinicalStudy(study(8, { own: true })).ownWork).toBe(true);
  });

  it("uses the full journal name when there is no abbreviation, and null when there is neither", () => {
    const s = study(1);
    s.citingDocument.journalAbbrev = null;
    expect(toClinicalStudy(s).journal).toBe("Journal of Widget Medicine");
    s.citingDocument.journal = null;
    expect(toClinicalStudy(s).journal).toBeNull();
  });

  it.each([
    "https://example.org/90000001/",
    "https://pubmed.ncbi.nlm.nih.gov.example.org/90000001/",
    "http://pubmed.ncbi.nlm.nih.gov/90000001/",
    "javascript:alert(1)",
  ])("drops a stored URL that is not on PubMed: %s", (url) => {
    expect(toClinicalStudy(study(1, { url })).url).toBeNull();
  });

  it("reads own work from JSON text too, and only from exactly true", () => {
    const own = (evidence: unknown) => toClinicalStudy({ ...study(1), evidence }).ownWork;
    expect(own('{"ownWork":true}')).toBe(true);
    expect(own({ ownWork: "true" })).toBe(false);
    expect(own({ ownTrial: true })).toBe(false);
    expect(own("not json")).toBe(false);
    expect(own(null)).toBe(false);
  });
});

describe("shapeClinicalCitations", () => {
  it("counts every study in total and leaves the authors' own out of count", () => {
    const rows = [study(1), study(2, { own: true }), study(3), study(4, { own: true }), study(5)];
    const shaped = shapeClinicalCitations(
      rows.slice(0, 2),
      rows.map((r) => r.evidence),
    )!;
    expect(shaped.total).toBe(5);
    expect(shaped.count).toBe(3);
    // The own study is in the list, marked.
    expect(shaped.items.map((i) => [i.id, i.ownWork])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("a paper cited only by the authors' own studies has a list and a count of 0", () => {
    const rows = [study(1, { own: true })];
    expect(shapeClinicalCitations(rows, [rows[0].evidence])).toMatchObject({ count: 0, total: 1 });
  });

  it("is undefined when nothing cites the paper", () => {
    expect(shapeClinicalCitations([], [])).toBeUndefined();
  });
});

describe("parseClinicalOffset", () => {
  it.each([
    ["0", 0],
    ["50", 50],
    ["5150", 5150],
    ["100000", 100000],
  ])("%s is a page start", (raw, n) => {
    expect(parseClinicalOffset(raw)).toBe(n);
  });

  it.each(["", "-50", "25", "51", "050", "00", "50.0", "5e1", "+50", " 50", "50abc", "100050", "9999950", "NaN"])(
    "%j is not",
    (raw) => {
      expect(parseClinicalOffset(raw)).toBeNull();
    },
  );

  it("the path is one URL per page, with the pmid encoded", () => {
    expect(clinicalCitationsPath("111", 50)).toBe("/api/publications/111/clinical-citations/50");
    expect(clinicalCitationsPath("a/b", 0)).toBe("/api/publications/a%2Fb/clinical-citations/0");
  });
});

describe("readClinicalCitations", () => {
  it("reads one page newest first, then by id, and counts over every link", async () => {
    store(Array.from({ length: 120 }, (_, i) => study(i + 1, { own: i % 10 === 0 })));
    const first = (await readClinicalCitations("111"))!;
    expect(first.items).toHaveLength(CLINICAL_PAGE_SIZE);
    expect(first.items[0].id).toBe(1);
    expect(first.total).toBe(120);
    expect(first.count).toBe(108);

    const page = clinicalCalls().find((a) => a.take !== undefined)!;
    expect(page.where).toEqual({ pmid: "111", citingDocument: { level: "clinical" } });
    expect(page.orderBy).toEqual([{ citingDocument: { year: "desc" } }, { citingDocumentId: "asc" }]);
    expect(page.skip).toBe(0);
    expect(page.take).toBe(CLINICAL_PAGE_SIZE);
  });

  it("pages to the end: the pages together are the whole list, once each", async () => {
    store(Array.from({ length: 120 }, (_, i) => study(i + 1)));
    const ids: number[] = [];
    for (const offset of [0, 50, 100]) {
      const page = (await readClinicalCitations("111", offset))!;
      expect(page.total).toBe(120);
      ids.push(...page.items.map((i) => i.id));
    }
    expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // Past the end: no rows, the same counts.
    expect(await readClinicalCitations("111", 150)).toEqual({ items: [], count: 120, total: 120 });
  });

  it("is undefined when the paper has none, and null on a read failure", async () => {
    expect(await readClinicalCitations("111")).toBeUndefined();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.links.mockRejectedValue(new Error("down"));
    expect(await readClinicalCitations("111")).toBeNull();
    error.mockRestore();
  });
});

describe("getPublicationDetail — CLINICAL_CITATIONS_MODAL", () => {
  it("off, or on with no clinical rows, the payload is the same bytes and off reads nothing", async () => {
    store([study(1), study(2, { own: true })]);
    const off = JSON.stringify(await getPublicationDetail("111"));
    expect(h.links).not.toHaveBeenCalled();
    expect(off).not.toContain("trialPatentCitations");
    expect(off).not.toContain("clinical");

    process.env.CLINICAL_CITATIONS_MODAL = "true";
    expect(JSON.stringify(await getPublicationDetail("111"))).toBe(off);
    expect(h.links).not.toHaveBeenCalled();

    process.env.CLINICAL_CITATIONS_MODAL = "on";
    store([]);
    expect(JSON.stringify(await getPublicationDetail("111"))).toBe(off);
  });

  it("on, a paper with only clinical studies gets the section, with the first page", async () => {
    process.env.CLINICAL_CITATIONS_MODAL = "on";
    store(Array.from({ length: 60 }, (_, i) => study(i + 1, { own: i === 0 })));
    const payload = (await getPublicationDetail("111"))!;
    expect(Object.keys(payload.trialPatentCitations!)).toEqual(["clinical"]);
    expect(payload.trialPatentCitations!.clinical).toMatchObject({ count: 59, total: 60 });
    expect(payload.trialPatentCitations!.clinical!.items).toHaveLength(50);
    expect(payload.policyCitations).toBeUndefined();
  });

  it("with the other groups on, clinical is added after them and leaves them as they were", async () => {
    process.env.TRIAL_CITATIONS_MODAL = "on";
    const trial = {
      evidence: null,
      citingDocument: {
        id: 900,
        level: "trial",
        externalId: "NCT90000001",
        title: "Trial NCT90000001",
        year: 2031,
        url: "https://clinicaltrials.gov/study/NCT90000001",
        dedupKey: "NCT90000001",
        details: { status: "RECRUITING" },
      },
    };
    const both = (rows: ClinicalLink[]) =>
      h.links.mockImplementation(async (args: FindArgs) => {
        const level = args.where.citingDocument.level;
        if (level !== "clinical") return [trial];
        return args.take === undefined ? rows.map((r) => ({ evidence: r.evidence })) : rows;
      });
    both([study(1)]);
    const before = (await getPublicationDetail("111"))!.trialPatentCitations!;
    expect(Object.keys(before)).toEqual(["trials"]);

    process.env.CLINICAL_CITATIONS_MODAL = "on";
    const after = (await getPublicationDetail("111"))!.trialPatentCitations!;
    expect(Object.keys(after)).toEqual(["trials", "clinical"]);
    expect(after.trials).toEqual(before.trials);
    expect(after.clinical).toMatchObject({ count: 1, total: 1 });
  });

  it("an external publication is never asked for clinical studies", async () => {
    process.env.CLINICAL_CITATIONS_MODAL = "on";
    h.publication.mockResolvedValue({ ...pub, pmid: "OPENALEX:W123" });
    const payload = (await getPublicationDetail("OPENALEX:W123"))!;
    expect(payload.trialPatentCitations).toBeUndefined();
    expect(clinicalCalls()).toHaveLength(0);
  });
});

describe("getClinicalCitationsPage — the public paged read", () => {
  beforeEach(() => {
    process.env.CLINICAL_CITATIONS_MODAL = "on";
    store(Array.from({ length: 120 }, (_, i) => study(i + 1)));
  });

  it("returns the page that starts at the offset", async () => {
    const result = await getClinicalCitationsPage("111", "100");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.page.items.map((i) => i.id)).toEqual(Array.from({ length: 20 }, (_, i) => 101 + i));
    expect(result.page).toMatchObject({ count: 120, total: 120 });
    // The page size is the server's: nothing in the request sets it.
    expect(clinicalCalls().find((a) => a.take !== undefined)!.take).toBe(CLINICAL_PAGE_SIZE);
  });

  it("flag off: not found, and nothing is read", async () => {
    process.env.CLINICAL_CITATIONS_MODAL = "off";
    expect(await getClinicalCitationsPage("111", "0")).toEqual({ status: "not_found" });
    expect(h.publication).not.toHaveBeenCalled();
    expect(h.links).not.toHaveBeenCalled();
  });

  it.each([
    ["111", "25"],
    ["111", "-50"],
    ["111", "abc"],
    ["111", "100050"],
    ["abc", "0"],
    ["0", "0"],
    ["111 OR 1=1", "0"],
    ["OPENALEX:W123", "0"],
    ["12345678901234567", "0"],
  ])("pmid %j offset %j: not found before any read", async (pmid, offset) => {
    expect(await getClinicalCitationsPage(pmid, offset)).toEqual({ status: "not_found" });
    expect(h.publication).not.toHaveBeenCalled();
    expect(h.links).not.toHaveBeenCalled();
  });

  it("a publication we do not hold: not found, and its citers are not read", async () => {
    h.links.mockImplementation(async () => [study(1)]);
    expect(await getClinicalCitationsPage("222", "0")).toEqual({ status: "not_found" });
    expect(h.links).not.toHaveBeenCalled();
  });

  it("a publication taken down: not found, as the modal itself is, and its citers are not read", async () => {
    h.suppression.mockResolvedValue([{ entityId: "111", contributorCwid: null }]);
    expect(await getPublicationDetail("111")).toBeNull();
    h.links.mockClear();
    expect(await getClinicalCitationsPage("111", "0")).toEqual({ status: "not_found" });
    expect(h.links).not.toHaveBeenCalled();
  });

  it("a shown publication with no clinical studies: not found", async () => {
    store([]);
    expect(await getClinicalCitationsPage("111", "0")).toEqual({ status: "not_found" });
  });

  it("a failed read is unavailable, not an empty list", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.links.mockRejectedValue(new Error("down"));
    expect(await getClinicalCitationsPage("111", "0")).toEqual({ status: "unavailable" });
    error.mockRestore();
  });
});

describe("GET /api/publications/:pmid/clinical-citations/:offset", () => {
  const get = (pmid: string, offset: string) =>
    GET(new Request("http://test.invalid/"), { params: Promise.resolve({ pmid, offset }) });

  beforeEach(() => {
    process.env.CLINICAL_CITATIONS_MODAL = "on";
    store(Array.from({ length: 60 }, (_, i) => study(i + 1, { own: i === 55 })));
  });

  it("200 with the page", async () => {
    const res = await get("111", "50");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(60);
    expect(body.count).toBe(59);
    expect(body.items).toHaveLength(10);
    expect(body.items[5]).toEqual({
      id: 56,
      title: "Widget study 56",
      url: "https://pubmed.ncbi.nlm.nih.gov/90000056/",
      journal: "J Widget Med",
      year: 2031,
      ownWork: true,
    });
  });

  it("404, uncached, for a bad offset, a taken-down publication and the flag off", async () => {
    const bad = await get("111", "7");
    expect(bad.status).toBe(404);
    expect(bad.headers.get("Cache-Control")).toBe("no-store");
    expect(await bad.json()).toEqual({ error: "Not found" });

    h.suppression.mockResolvedValue([{ entityId: "111", contributorCwid: null }]);
    expect((await get("111", "0")).status).toBe(404);
    h.suppression.mockResolvedValue([]);

    process.env.CLINICAL_CITATIONS_MODAL = "off";
    expect((await get("111", "0")).status).toBe(404);
  });

  it("500, uncached, when the read fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.links.mockRejectedValue(new Error("down"));
    const res = await get("111", "0");
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    error.mockRestore();
  });
});
