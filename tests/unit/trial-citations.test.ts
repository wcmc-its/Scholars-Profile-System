/** Trial citations (etl:policy-citations, trials pass): the pure shaping, the
 *  ClinicalTrials.gov client, and the proof that a citing trial stored at level
 *  `trial`, or a citing patent at level `patent` (etl/patent-citations), changes
 *  nothing the existing readers show: report 24, the public badges, the
 *  publication modal and the Bibliometrics tab. NCT numbers, patent numbers,
 *  PMIDs, people and sponsors are invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  links: vi.fn(),
  scholar: vi.fn(),
  authorships: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { publicationCitingDocument: { findMany: h.links } },
  db: {
    read: {
      $queryRaw: h.queryRaw,
      scholar: { findUnique: h.scholar },
      publicationAuthor: { findMany: h.authorships },
      suppression: { findMany: vi.fn(async () => []) },
    },
    write: {},
  },
}));

import { BACKGROUND_TERM, ctgovStudies, referencesTerm } from "@/etl/policy-citations/ctgov";
import { backgroundRefs, isOwnTrial, trialDoc, type CtgovStudy } from "@/etl/policy-citations/shape";
import { readPolicyCitations } from "@/lib/api/publication-detail";
import { POLICY_LEVELS, toPolicyRollup } from "@/lib/citations/policy-rollup";
import { loadBibliometricsReport } from "@/lib/edit/bibliometrics-loader";
import {
  citedSql,
  LEVELS,
  loadCitationPairs,
  loadCitingDocuments,
  loadDocLinks,
  parsePolicyCitationParams,
} from "@/lib/edit/policy-citations-report";
import { Prisma } from "@/lib/generated/prisma/client";

const RANKED = ["authority", "guideline", "consensus", "review"];
/** The levels `citing_document` holds that are not ranked. */
const UNRANKED = ["trial", "patent"];

const study = (nct: string, references: Array<{ pmid?: string; type?: string }>): CtgovStudy => ({
  protocolSection: {
    identificationModule: { nctId: nct, briefTitle: "A Study of <i>Something</i> &amp; Something Else" },
    statusModule: { overallStatus: "RECRUITING", startDateStruct: { date: "2031-04" } },
    sponsorCollaboratorsModule: { leadSponsor: { name: "Example University", class: "OTHER" } },
    designModule: { studyType: "INTERVENTIONAL", phases: ["PHASE2", "PHASE3"] },
    referencesModule: { references },
  },
});

describe("trial shaping", () => {
  it("keeps background references only, once each, and counts those with no PMID", () => {
    const refs = backgroundRefs(
      study("NCT90000001", [
        { pmid: "111", type: "BACKGROUND" },
        { pmid: " 111 ", type: "BACKGROUND" },
        { pmid: "222", type: "RESULT" },
        { pmid: "333", type: "DERIVED" },
        { type: "BACKGROUND" },
        { pmid: "not a pmid", type: "BACKGROUND" },
        { pmid: "444" },
      ]),
    );
    expect(refs).toEqual({ pmids: ["111"], noPmid: 2 });
    expect(backgroundRefs({})).toEqual({ pmids: [], noPmid: 0 });
  });

  it("maps a study to one citing document keyed by its NCT number", () => {
    expect(trialDoc(study("NCT90000001", []))).toEqual({
      source: "ctgov",
      externalId: "NCT90000001",
      title: "A Study of Something & Something Else",
      year: 2031,
      url: "https://clinicaltrials.gov/study/NCT90000001",
      level: "trial",
      issuingBody: null,
      dedupKey: "NCT90000001",
      authors: null,
      journal: null,
      journalAbbrev: null,
      volume: null,
      issue: null,
      pages: null,
      doi: null,
      publisher: null,
      details: {
        phase: "PHASE2/PHASE3",
        sponsor: "Example University",
        sponsorClass: "OTHER",
        status: "RECRUITING",
        studyType: "INTERVENTIONAL",
        startDate: "2031-04",
      },
    });
  });

  it("copes with a bare study and refuses one without an NCT number", () => {
    expect(trialDoc({ protocolSection: { identificationModule: { nctId: "NCT90000002" } } })).toMatchObject({
      title: "NCT90000002",
      year: null,
      details: { phase: null, sponsor: null, sponsorClass: null, status: null, studyType: null, startDate: null },
    });
    expect(trialDoc({})).toBeNull();
    expect(trialDoc({ protocolSection: { identificationModule: { nctId: "ISRCTN123" } } })).toBeNull();
  });

  it("flags the authors' own trial: a confirmed author is an investigator", () => {
    const authors = new Set(["aaa1001", "bbb1002"]);
    expect(isOwnTrial(authors, new Set(["bbb1002", "ccc1003"]))).toBe(true);
    // Another WCM trial, none of this paper's authors on it: counts like anyone's.
    expect(isOwnTrial(authors, new Set(["ccc1003"]))).toBe(false);
    // Not a WCM-run trial, or a paper with no confirmed WCM author.
    expect(isOwnTrial(authors, undefined)).toBe(false);
    expect(isOwnTrial(undefined, new Set(["aaa1001"]))).toBe(false);
  });
});

describe("ClinicalTrials.gov client", () => {
  type Reply = { status?: number; body?: unknown };
  function fake(replies: Reply[]) {
    const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: new URL(String(url)), headers: init!.headers as Record<string, string> });
      const r = replies[Math.min(calls.length, replies.length) - 1];
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as typeof fetch;
    return { calls, opts: { fetchFn, retryBaseMs: 0, delayMs: 0 } };
  }
  const read = async (term: string, opts: Parameters<typeof ctgovStudies>[1]) => {
    const out: CtgovStudy[] = [];
    for await (const page of ctgovStudies(term, opts)) out.push(...page);
    return out;
  };
  const one = study("NCT90000001", []);

  it("asks about many papers in one call", () => {
    expect(referencesTerm(["111", "222", "333"])).toBe("AREA[ReferencePMID](111 OR 222 OR 333)");
  });

  it("follows page tokens to the end, asking only for the fields it stores", async () => {
    const { calls, opts } = fake([
      { body: { totalCount: 3, studies: [one, one], nextPageToken: "tok" } },
      { body: { studies: [one] } },
    ]);
    expect(await read(BACKGROUND_TERM, opts)).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe("https://clinicaltrials.gov/api/v2/studies");
    expect(calls[0].url.searchParams.get("query.term")).toBe("AREA[ReferenceType]BACKGROUND");
    expect(calls[0].url.searchParams.get("fields")).toContain("ReferencesModule");
    expect(calls[0].url.searchParams.get("pageSize")).toBe("1000");
    expect(calls[0].url.searchParams.get("countTotal")).toBe("true");
    expect(calls[1].url.searchParams.get("pageToken")).toBe("tok");
    // Generic client name: no person, institution or contact address.
    expect(calls[0].headers["User-Agent"]).toBe("scholars-etl/1.0");
  });

  it("retries a 429 and a 5xx, then reads the answer", async () => {
    const { calls, opts } = fake([{ status: 429 }, { status: 503 }, { body: { totalCount: 1, studies: [one] } }]);
    expect(await read(BACKGROUND_TERM, opts)).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("gives up after the retries, and at once on a bad request", async () => {
    const down = fake([{ status: 503 }]);
    await expect(read(BACKGROUND_TERM, down.opts)).rejects.toThrow("failed after 6 attempts: HTTP 503");
    const bad = fake([{ status: 400, body: { message: "bad term" } }]);
    await expect(read("AREA[Nope]x", bad.opts)).rejects.toThrow("ctgov HTTP 400");
    expect(bad.calls).toHaveLength(1);
  });

  it("throws on a walk that came up short of the registry's own count", async () => {
    const { opts } = fake([{ body: { totalCount: 5000, studies: [one] } }]);
    await expect(read(BACKGROUND_TERM, opts)).rejects.toThrow("read 1 of 5000");
  });

  it("no match is an answer, not a failure", async () => {
    const { opts } = fake([{ body: { totalCount: 0, studies: [] } }]);
    expect(await read(referencesTerm(["111"]), opts)).toEqual([]);
  });
});

/** A `Prisma.Sql` as one-spaced text plus its bound values. */
const flat = (sql: Prisma.Sql) => ({ text: sql.sql.replace(/\s+/g, " "), values: sql.values });
const call = (n: number) => {
  const [strings, ...values] = h.queryRaw.mock.calls[n] as [TemplateStringsArray, ...unknown[]];
  return flat(Prisma.sql(strings, ...values));
};
const parse = (qs = "") => ({ ...parsePolicyCitationParams(new URLSearchParams(qs)), scope: null });

describe("a citing trial or patent changes none of the existing counts", () => {
  beforeEach(() => {
    h.queryRaw.mockReset().mockResolvedValue([]);
    h.links.mockReset().mockResolvedValue([]);
  });

  it("is not one of the ranked levels", () => {
    expect([...POLICY_LEVELS]).toEqual(RANKED);
    expect([...LEVELS]).toEqual(RANKED);
    // Nor can a URL ask report 24 for it.
    for (const level of UNRANKED) expect(parse(`level=${level}`).levels).toEqual([]);
  });

  it("report 24, rollup path: reads the four ranked rollups, never trial_count or patent_family_count", () => {
    const { text } = flat(citedSql(parse()));
    expect(text).toContain("FROM publication WHERE authority_count > 0 OR guideline_count > 0 OR consensus_count > 0 OR review_count > 0");
    expect(text).not.toContain("trial");
    expect(text).not.toContain("patent");
  });

  it("report 24, live path: the aggregate (counts and the newest citing year) is over the ranked levels only", () => {
    const { text, values } = flat(citedSql(parse("basis=cy&cfrom=2020")));
    expect(text).toContain("MAX(d.year) AS latest");
    expect(text).toContain("WHERE d.level IN (?,?,?,?) AND d.year >= ?");
    // Four CASE levels, then the WHERE's four, then the year.
    expect(values).toEqual([...RANKED, ...RANKED, 2020]);
  });

  it("report 24, every list of citing documents names its levels in SQL", async () => {
    await loadCitingDocuments(parse(), ["111"]);
    expect(call(0).text).toContain("JOIN citing_document d ON d.id = l.citing_document_id WHERE d.level IN (?,?,?,?)");
    for (const level of UNRANKED) expect(call(0).values).not.toContain(level);
    await loadDocLinks(parse());
    expect(call(1).text).toContain("WHERE d.level IN (?,?,?)");
    for (const level of UNRANKED) expect(call(1).values).not.toContain(level);
    // The workbook's Citations sheet, with no Level picked and with an unranked level asked for by URL.
    for (const qs of ["level=", "level=trial", "level=patent"]) {
      h.queryRaw.mockClear();
      await loadCitationPairs(parse(qs), [{ pmid: "111", title: "t" }]);
      expect(call(0).text).toContain("WHERE d.level IN (?,?,?,?)");
      expect(call(0).values).toEqual(expect.arrayContaining(RANKED));
      for (const level of UNRANKED) expect(call(0).values).not.toContain(level);
    }
  });

  it("report 24 drops a trial or patent row even if one came back", async () => {
    const row = (id: number, level: string) => ({
      pmid: "111",
      id,
      dedup_key: `k${id}`,
      level,
      title: `Document ${id}`,
      year: 2031,
      url: "https://example.org/",
      issuing_body: null,
      authors: null,
      journal: null,
      journal_abbrev: null,
      volume: null,
      issue: null,
      pages: null,
      doi: null,
      publisher: null,
      source: level === "trial" ? "ctgov" : level === "patent" ? "ros" : "pubmed",
      external_id: String(id),
      locations: null,
    });
    h.queryRaw.mockResolvedValueOnce([row(1, "guideline"), row(2, "trial"), row(3, "patent")]);
    const docs = (await loadCitingDocuments(parse(), ["111"])).get("111")!;
    expect(docs.map((d) => [d.id, d.level])).toEqual([[1, "guideline"]]);
  });

  it("public badges: the rollup the row renders has no trial or patent in it", () => {
    const row = { authorityBodies: null, guidelineCount: 0, reviewCount: 0, trialCount: 7, patentFamilyCount: 12 };
    expect(toPolicyRollup(row)).toBeNull();
    expect(toPolicyRollup({ ...row, guidelineCount: 2 })).toEqual({ authority: [], guidelines: 2, reviews: 0 });
  });

  it("publication modal: asks for documents at the ranked levels only", async () => {
    await readPolicyCitations("111");
    expect(h.links).toHaveBeenCalledTimes(1);
    expect(h.links.mock.calls[0][0].where).toEqual({ pmid: "111", citingDocument: { level: { in: RANKED } } });
  });

  it("publication modal: the payload is the same with a trial and a patent row stored", async () => {
    const doc = (id: number, level: string, source: string) => ({
      id,
      level,
      source,
      externalId: String(id),
      title: `Document ${id}`,
      year: 2031,
      url: "https://example.org/",
      issuingBody: null,
      authors: null,
      journal: null,
      journalAbbrev: null,
      volume: null,
      issue: null,
      pages: null,
      doi: null,
      publisher: null,
      dedupKey: `k${id}`,
      details: null,
    });
    // The table as the query sees it: the level filter is applied, as MySQL would.
    const payload = async (table: Array<ReturnType<typeof doc>>) => {
      h.links.mockReset().mockImplementation(async ({ where }) =>
        table
          .filter((d) => where.citingDocument.level.in.includes(d.level))
          .map((d) => ({ citingDocument: d, locations: null })),
      );
      return readPolicyCitations("111");
    };
    const before = await payload([doc(1, "guideline", "pubmed")]);
    expect(before!.docs.map((d) => d.id)).toEqual([1]);
    expect(await payload([doc(1, "guideline", "pubmed"), doc(2, "trial", "ctgov"), doc(3, "patent", "ros")])).toEqual(before);
  });

  it("Bibliometrics tab: distinct citing documents are counted at the ranked levels only", async () => {
    h.scholar.mockResolvedValue({ cwid: "aaa1001", preferredName: "Test Person", hIndex: 3 });
    h.authorships.mockResolvedValue([
      {
        position: 1,
        isFirst: true,
        isLast: false,
        publication: {
          pmid: "111",
          title: "A paper",
          authorsString: "Person T",
          journal: "J Ex",
          year: 2030,
          volume: null,
          issue: null,
          pages: null,
          doi: null,
          publicationType: "Academic Article",
          citationCount: 4,
          citedByCount: 4,
          nihPercentile: null,
          relativeCitationRatio: null,
          dateAddedToEntrez: null,
          authorityBodies: null,
          authorityCount: 0,
          guidelineCount: 2,
          consensusCount: 0,
          reviewCount: 0,
        },
      },
    ]);
    const counts = [{ level: "guideline", body: null, n: 2 }];
    const policyOf = async (rows: unknown[]) => {
      h.queryRaw.mockReset().mockResolvedValue(rows);
      const report = await loadBibliometricsReport("aaa1001", { authorship: "all", yearFrom: null, yearTo: null });
      return report!.policy;
    };
    const before = await policyOf(counts);
    expect(call(0).text).toContain("AND d.level IN (?,?,?,?) GROUP BY d.level, d.issuing_body");
    expect(call(0).values).toEqual(["111", ...RANKED]);
    expect(before.find((l) => l.level === "guideline")).toMatchObject({ papers: 1, documents: 2 });
    // And a trial or patent row, were one to come back, moves nothing.
    expect(await policyOf([...counts, { level: "trial", body: null, n: 9 }])).toEqual(before);
    expect(await policyOf([...counts, { level: "patent", body: null, n: 1622 }])).toEqual(before);
    expect(before.map((l) => l.level)).toEqual(RANKED);
  });
});
