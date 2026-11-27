/** Patent citations (etl:patent-citations:import): the pure shaping, the extract
 *  reader, and the loader against an in-memory client. That a stored patent row
 *  changes nothing the existing readers show is proved beside the trials, in
 *  tests/unit/trial-citations.test.ts. Patent numbers, application numbers,
 *  PMIDs, OpenAlex ids, inventors and assignees are invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The four tables the loader touches, held in memory. */
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const t = { publication: [] as Row[], doc: [] as Row[], link: [] as Row[], openalex: [] as Row[], sql: [] as string[] };
  let nextId = 1;
  /** `createMany` with `skipDuplicates`: a row whose key is taken is left alone. */
  const insert = (rows: Row[], key: (r: Row) => string, more: (r: Row) => Row = (r) => r) =>
    vi.fn(async ({ data }: { data: Row[] }) => {
      const taken = new Set(rows.map(key));
      const fresh = data.filter((r) => !taken.has(key(r)) && taken.add(key(r)));
      rows.push(...fresh.map((r) => more({ ...r })));
      return { count: fresh.length };
    });
  const write = {
    publication: { findMany: vi.fn(async () => t.publication) },
    citingDocument: {
      findMany: vi.fn(async () => t.doc.filter((d) => d.source === "ros")),
      createMany: insert(t.doc, (d) => `${d.source}|${d.externalId}`, (d) => ({ ...d, id: nextId++ })),
      update: vi.fn(async ({ where, data }: { where: { source_externalId: Row }; data: Row }) => {
        Object.assign(t.doc.find((d) => d.externalId === where.source_externalId.externalId)!, data);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: number[] } } }) => {
        const gone = t.doc.filter((d) => where.id.in.includes(d.id as number));
        for (const d of gone) t.doc.splice(t.doc.indexOf(d), 1);
        return { count: gone.length };
      }),
    },
    publicationCitingDocument: {
      findMany: vi.fn(async () => t.link),
      createMany: insert(t.link, (l) => `${l.pmid}|${l.citingDocumentId}`),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        Object.assign(t.link.find((l) => l.pmid === where.pmid && l.citingDocumentId === where.citingDocumentId)!, data);
      }),
      deleteMany: vi.fn(async ({ where }: { where: { OR: Row[] } }) => {
        const gone = t.link.filter((l) => where.OR.some((w) => w.pmid === l.pmid && w.citingDocumentId === l.citingDocumentId));
        for (const l of gone) t.link.splice(t.link.indexOf(l), 1);
        return { count: gone.length };
      }),
    },
    publicationOpenalex: { createMany: insert(t.openalex, (m) => `${m.pmid}|${m.openalexId}`) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      t.sql.push(strings.join("?").replace(/\s+/g, " "));
      return 0;
    }),
  };
  return { t, write };
});
vi.mock("@/lib/db", () => ({ db: { write: h.write } }));

import { loadExtract, readExtract, shapeExtract, type Extract } from "@/etl/patent-citations/load";
import {
  decideSharedId,
  familyKey,
  linkEvidence,
  parsePatentId,
  patentDoc,
  stable,
  type SharedIdFacts,
} from "@/etl/patent-citations/shape";
import { EtlGuardError } from "@/lib/etl-guard";

describe("patent ids", () => {
  it("reads a grant, old or new, keyed by its number", () => {
    expect(parsePatentId("us-90000001-b2")).toEqual({ kind: "grant", number: "90000001", display: "US90000001B2" });
    expect(parsePatentId("us-9000001-b1")).toMatchObject({ kind: "grant", number: "9000001" });
    expect(parsePatentId("us-900001-a")).toEqual({ kind: "grant", number: "900001", display: "US900001A" });
  });

  it("puts the dropped zero back into a ten-digit pre-grant number", () => {
    expect(parsePatentId("us-2031900001-a1")).toEqual({
      kind: "application",
      number: "20310900001",
      display: "US20310900001A1",
    });
    // Already eleven digits: left alone. Other pre-grant kind codes read the same way.
    expect(parsePatentId("us-20310900001-a1")!.number).toBe("20310900001");
    expect(parsePatentId("us-2031900001-a9")).toMatchObject({ kind: "application", number: "20310900001" });
  });

  it("keys a reissue held under two dataset ids on one patent number", () => {
    const a = parsePatentId("us-re90001-e")!;
    const b = parsePatentId("us-re90001-e1")!;
    expect(a).toEqual({ kind: "reissue", number: "RE90001", display: "USRE90001E" });
    expect(b.number).toBe(a.number);
    expect(b.display).toBe("USRE90001E1");
  });

  it("reads an H number with or without zero padding, and a design", () => {
    expect(parsePatentId("us-h9001-h")).toEqual({ kind: "other", number: "H9001", display: "USH9001H" });
    expect(parsePatentId("us-h009001-h")!.number).toBe("H9001");
    expect(parsePatentId("us-d900001-s")).toMatchObject({ kind: "design", number: "D900001" });
    expect(parsePatentId("us-pp90001-p2")).toMatchObject({ kind: "other", number: "PP90001" });
  });

  it("refuses a malformed id", () => {
    for (const id of ["us-dk-209900001-a1", "us-dk-209900002-u1", "ep-1234567-b1", "us-90000001", "US-90000001-B2", "us-b900001-i5", "us-9001-p", ""]) {
      expect(parsePatentId(id), id).toBeNull();
    }
  });
});

describe("family key", () => {
  const grant = parsePatentId("us-90000001-b2")!;

  it("is the built family where the extract found one", () => {
    expect(familyKey({ familyKey: "70000001", applicationId: "70000009" }, grant)).toBe("70000001");
  });

  it("is the document's own application otherwise, so a pre-grant publication and its grant count once", () => {
    const row = { applicationId: "70000009" };
    expect(familyKey(row, grant)).toBe("70000009");
    expect(familyKey(row, parsePatentId("us-2031900001-a1")!)).toBe("70000009");
  });

  it("is the patent number when there is no application: its own invention, once per patent", () => {
    expect(familyKey({}, parsePatentId("us-h9001-h")!)).toBe("doc:H9001");
    expect(familyKey({ familyKey: null, applicationId: "" }, parsePatentId("us-re90001-e")!)).toBe(
      familyKey({}, parsePatentId("us-re90001-e1")!),
    );
  });
});

describe("patent document shaping", () => {
  const row = {
    id: "us-90000001-b2",
    title: " A widget for testing ",
    grantDate: "2031-04-08",
    filingDate: "2029-01-15",
    applicationId: "70000009",
    familyKey: "70000001",
    familySize: 3,
    assignees: ["Example Devices, Inc."],
    inventors: [{ first: "Ada", last: "Example" }],
  };

  it("maps a grant to one citing document whose dedup key is its family", () => {
    expect(patentDoc(row, "2030-01-01")).toEqual({
      source: "ros",
      externalId: "us-90000001-b2",
      title: "A widget for testing",
      year: 2031,
      url: "https://patents.google.com/patent/US90000001B2/en",
      level: "patent",
      issuingBody: null,
      dedupKey: "70000001",
      authors: null,
      journal: null,
      journalAbbrev: null,
      volume: null,
      issue: null,
      pages: null,
      doi: null,
      publisher: null,
      details: {
        kind: "grant",
        grantDate: "2031-04-08",
        publicationDate: null,
        filingDate: "2029-01-15",
        familyKey: "70000001",
        familySize: 3,
        assignees: ["Example Devices, Inc."],
        inventors: [{ first: "Ada", last: "Example" }],
        metadataRelease: "2030-01-01",
      },
    });
  });

  it("dates a pre-grant publication by its publication, and copes with no assignee", () => {
    const doc = patentDoc({ id: "us-2031900001-a1", title: "T", publicationDate: "2031-06-01", applicationId: "70000009" }, "r")!;
    expect(doc).toMatchObject({ year: 2031, dedupKey: "70000009", url: "https://patents.google.com/patent/US20310900001A1/en" });
    expect(doc.details).toMatchObject({ kind: "application", grantDate: null, assignees: [], inventors: [], familySize: 1 });
  });

  it("titles a document the patent tables do not have by its number, and says so", () => {
    const doc = patentDoc({ id: "us-h9001-h" }, "r")!;
    expect(doc).toMatchObject({ title: "USH9001H", year: null, dedupKey: "doc:H9001" });
    expect(doc.details.metadataMissing).toBe(true);
  });

  it("caps long name lists and refuses a malformed id", () => {
    const many = Array.from({ length: 45 }, (_, i) => ({ first: "Inventor", last: `Number${i}` }));
    const doc = patentDoc({ ...row, inventors: many, assignees: Array.from({ length: 9 }, (_, i) => `Assignee ${i}`) }, "r")!;
    expect(doc.details.inventors).toHaveLength(20);
    expect(doc.details.assignees).toHaveLength(5);
    expect(patentDoc({ id: "us-dk-209900001-a1" }, "r")).toBeNull();
  });
});

describe("link evidence", () => {
  it("stores the score and where the citation was found", () => {
    expect(linkEvidence({ pmid: "111", doc: "d", score: 7, where: "body" }, "zenodo:1")).toEqual({
      score: 7,
      where: "body",
      release: "zenodo:1",
    });
    expect(linkEvidence({ pmid: "111", doc: "d", score: 10, where: "both", sharedId: true }, "zenodo:1")).toMatchObject({
      sharedId: true,
    });
  });

  it("keeps confidence 4 and above only, and nothing it cannot read", () => {
    const link = (score: number, where = "front") => linkEvidence({ pmid: "111", doc: "d", score, where }, "r");
    expect(link(4)).not.toBeNull();
    expect(link(3)).toBeNull();
    expect(link(11)).toBeNull();
    expect(link(7.5)).toBeNull();
    expect(link(7, "frontonly")).toBeNull();
  });
});

describe("tie-break for a shared OpenAlex id", () => {
  const facts = (over: Partial<SharedIdFacts> = {}): SharedIdFacts => ({
    workYear: 2005,
    workDoi: "10.5555/example.1",
    api: { pmid: "111", year: 2005, doi: null },
    crosswalk: { pmid: "222", year: 2005, doi: null },
    crosswalkHasOwnWork: false,
    ...over,
  });

  it("rule 1: the crosswalk's paper has its own work now, so the API's paper keeps the id", () => {
    // Even when year and DOI would point the other way.
    expect(
      decideSharedId(facts({ crosswalkHasOwnWork: true, api: { pmid: "111", year: 1990, doi: null }, crosswalk: { pmid: "222", year: 2005, doi: "10.5555/example.1" } })),
    ).toEqual({ rule: "own-work", winner: "111" });
  });

  it("rule 2: the paper published within a year of the work wins, whichever source named it", () => {
    expect(decideSharedId(facts({ crosswalk: { pmid: "222", year: 2017, doi: null } }))).toEqual({ rule: "year", winner: "111" });
    expect(decideSharedId(facts({ workYear: 1998, api: { pmid: "111", year: 2017, doi: null }, crosswalk: { pmid: "222", year: 1999, doi: null } }))).toEqual({
      rule: "year",
      winner: "222",
    });
  });

  it("rule 2: when the years do not separate them, an exact DOI match wins", () => {
    expect(decideSharedId(facts({ api: { pmid: "111", year: 2005, doi: " 10.5555/EXAMPLE.1 " } }))).toEqual({ rule: "doi", winner: "111" });
    // Neither year fits: the DOI still decides.
    expect(
      decideSharedId(facts({ api: { pmid: "111", year: 2010, doi: null }, crosswalk: { pmid: "222", year: 2011, doi: "10.5555/example.1" } })),
    ).toEqual({ rule: "doi", winner: "222" });
  });

  it("rule 3: still tied, so neither", () => {
    expect(decideSharedId(facts())).toEqual({ rule: "unresolved", winner: null });
    // Both carry the work's DOI (a paper indexed twice).
    expect(
      decideSharedId(facts({ api: { pmid: "111", year: 2005, doi: "10.5555/example.1" }, crosswalk: { pmid: "222", year: 2005, doi: "10.5555/example.1" } })),
    ).toEqual({ rule: "unresolved", winner: null });
    // No year and no DOI on the work: nothing to compare with.
    expect(decideSharedId(facts({ workYear: null, workDoi: null }))).toEqual({ rule: "unresolved", winner: null });
  });
});

it("stable JSON sorts keys at every depth", () => {
  expect(stable({ b: [{ last: "x", first: "y" }], a: null })).toBe(stable({ a: null, b: [{ first: "y", last: "x" }] }));
  expect(stable({ a: 1 })).not.toBe(stable({ a: 2 }));
  expect(stable(undefined)).toBe("null");
});

/** A small extract: three papers considered, two cited, by three documents of two inventions. */
function extractLines(over: { links?: object[]; counts?: Record<string, number> } = {}): string[] {
  const rows: object[] = [
    { t: "considered", pmids: ["111", "222"] },
    { t: "considered", pmids: ["333"] },
    { t: "map", pmid: "111", openalexId: "W9000000001", source: "api" },
    { t: "map", pmid: "222", openalexId: "W9000000002", source: "crosswalk-2023" },
    {
      t: "tie",
      openalexId: "W9000000002",
      workYear: 2005,
      workDoi: null,
      crosswalkHasOwnWork: false,
      api: { pmid: "444", year: 2017, doi: null },
      crosswalk: { pmid: "222", year: 2005, doi: null },
      rule: "year",
      winner: "222",
    },
    { t: "doc", id: "us-90000001-b2", title: "A widget", grantDate: "2031-04-08", applicationId: "70000009", familyKey: "70000001", familySize: 2, assignees: ["Example Devices, Inc."], inventors: [{ first: "Ada", last: "Example" }] },
    { t: "doc", id: "us-2030900001-a1", title: "A widget", publicationDate: "2030-02-01", applicationId: "70000001", familyKey: "70000001", familySize: 2, assignees: [], inventors: [{ first: "Ada", last: "Example" }] },
    { t: "doc", id: "us-90000002-b1", title: "Another widget", grantDate: "2032-01-06", applicationId: "70000050", assignees: [], inventors: [] },
    { t: "doc", id: "us-dk-209900001-a1" },
    ...(over.links ?? [
      { t: "link", pmid: "111", doc: "us-90000001-b2", score: 10, where: "both" },
      { t: "link", pmid: "111", doc: "us-2030900001-a1", score: 8, where: "body" },
      { t: "link", pmid: "222", doc: "us-90000002-b1", score: 4, where: "front", sharedId: true },
      { t: "link", pmid: "222", doc: "us-dk-209900001-a1", score: 10, where: "front" },
    ]),
  ];
  const n = (t: string) => rows.filter((r) => (r as { t: string }).t === t).length;
  const header = {
    t: "header",
    format: 1,
    release: "zenodo:1",
    metadataRelease: "2030-01-01",
    mappedAt: "2030-06-01",
    counts: { considered: 3, map: n("map"), tie: n("tie"), doc: n("doc"), link: n("link"), ...over.counts },
  };
  return [header, ...rows].map((r) => JSON.stringify(r));
}

describe("reading an extract", () => {
  it("parses every row type", () => {
    const x = readExtract([...extractLines(), ""]);
    expect(x.header.release).toBe("zenodo:1");
    expect([...x.considered]).toEqual(["111", "222", "333"]);
    expect([x.maps.length, x.ties.length, x.docs.length, x.links.length]).toEqual([2, 1, 4, 4]);
  });

  it("refuses a file cut short of its own header's counts", () => {
    expect(() => readExtract(extractLines().slice(0, -1))).toThrow("its header promises 4 link rows, the file has 3");
  });

  it("refuses a file that is not an extract, and a row it does not know", () => {
    expect(() => readExtract([JSON.stringify({ t: "i", nctNumber: "x" })])).toThrow("not a format 1 header");
    expect(() => readExtract([])).toThrow("empty");
    expect(() => readExtract([...extractLines(), JSON.stringify({ t: "bogus" })])).toThrow('unknown row type "bogus"');
    expect(() => readExtract([extractLines()[0], "{not json"])).toThrow();
  });
});

describe("shaping an extract", () => {
  it("skips a malformed document with its links, and a link below the floor", () => {
    const x = readExtract(
      extractLines({
        links: [
          { t: "link", pmid: "111", doc: "us-90000001-b2", score: 10, where: "both" },
          { t: "link", pmid: "111", doc: "us-90000002-b1", score: 3, where: "front" },
          { t: "link", pmid: "222", doc: "us-dk-209900001-a1", score: 10, where: "front" },
        ],
      }),
    );
    const shaped = shapeExtract(x);
    expect(shaped.unreadable).toEqual(["us-dk-209900001-a1"]);
    expect(shaped.dropped).toEqual({ noDocument: 1, belowFloor: 1 });
    expect(shaped.links).toHaveLength(1);
    // A document nothing links to any more is not loaded.
    expect(shaped.docs.map((d) => d.externalId)).toEqual(["us-90000001-b2"]);
  });

  it("refuses a file whose tie-break winner is not what the rule gives", () => {
    const x = readExtract(extractLines());
    x.ties[0] = { ...x.ties[0], winner: "444" };
    expect(() => shapeExtract(x)).toThrow("The extract and the importer disagree");
  });
});

describe("loading an extract", () => {
  const extract = (): Extract => readExtract(extractLines());

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.ETL_GUARD_BYPASS;
    for (const k of ["publication", "doc", "link", "openalex", "sql"] as const) h.t[k].length = 0;
    // 111 and 333 are here; 222 is cited by the file and absent from this database.
    h.t.publication.push({ pmid: "111" }, { pmid: "333" });
    // Rows of the other sources, which the loader must never read or touch.
    h.t.doc.push({ id: 900, source: "pubmed", externalId: "5550001", level: "guideline", dedupKey: "k" });
  });

  it("reports what the file holds and what the database lacks, then writes it", async () => {
    const summary = await loadExtract(extract());
    expect(summary.file).toEqual({ documents: 3, links: 3, inventions: 2, publications: 2 });
    expect(summary.notInDatabase).toEqual({ documents: 3, links: 3, inventions: 2, publications: 1 });
    expect(summary.unconsidered).toBe(0);
    expect(summary.written).toEqual({ mappings: 2, documents: 3, documentsRefreshed: 0, links: 3, linksRefreshed: 0, linksDeleted: 0, documentsDeleted: 0, rollup: 0 });

    const ros = h.t.doc.filter((d) => d.source === "ros");
    expect(ros.map((d) => [d.externalId, d.level, d.dedupKey])).toEqual([
      ["us-90000001-b2", "patent", "70000001"],
      ["us-2030900001-a1", "patent", "70000001"],
      ["us-90000002-b1", "patent", "70000050"],
    ]);
    expect(h.t.link.map((l) => l.evidence)).toEqual([
      { score: 10, where: "both", release: "zenodo:1" },
      { score: 8, where: "body", release: "zenodo:1" },
      { score: 4, where: "front", release: "zenodo:1", sharedId: true },
    ]);
    expect(h.t.openalex).toEqual([
      { pmid: "111", openalexId: "W9000000001", source: "api", checkedAt: new Date("2030-06-01") },
      { pmid: "222", openalexId: "W9000000002", source: "crosswalk-2023", checkedAt: new Date("2030-06-01") },
    ]);
  });

  it("rolls up patent_family_count and no other column", async () => {
    await loadExtract(extract());
    expect(h.t.sql).toHaveLength(1);
    expect(h.t.sql[0]).toContain("COUNT(DISTINCT d.dedup_key) AS pf");
    expect(h.t.sql[0]).toContain("WHERE d.level = 'patent'");
    expect(h.t.sql[0]).toContain("SET p.patent_family_count = COALESCE(x.pf, 0) WHERE p.patent_family_count <> COALESCE(x.pf, 0)");
    expect(h.t.sql[0]).not.toMatch(/authority|guideline|consensus|review|trial|latest_citing_year/);
  });

  it("is idempotent: a second run of the same file adds and changes nothing", async () => {
    await loadExtract(extract());
    const after = structuredClone(h.t);
    const again = await loadExtract(extract());
    expect(again.notInDatabase).toEqual({ documents: 0, links: 0, inventions: 0, publications: 1 });
    expect(again.written).toEqual({ mappings: 0, documents: 0, documentsRefreshed: 0, links: 0, linksRefreshed: 0, linksDeleted: 0, documentsDeleted: 0, rollup: 0 });
    expect({ ...h.t, sql: [] }).toEqual({ ...after, sql: [] });
    expect(h.write.citingDocument.update).not.toHaveBeenCalled();
    expect(h.write.publicationCitingDocument.updateMany).not.toHaveBeenCalled();
  });

  it("is idempotent when the database hands JSON back with its keys in another order", async () => {
    await loadExtract(extract());
    for (const d of h.t.doc.filter((d) => d.source === "ros")) {
      d.details = Object.fromEntries(Object.entries(d.details as object).reverse());
    }
    for (const l of h.t.link) l.evidence = Object.fromEntries(Object.entries(l.evidence as object).reverse());
    expect((await loadExtract(extract())).written).toMatchObject({ documentsRefreshed: 0, linksRefreshed: 0 });
  });

  it("rewrites a regrouped family and a restated score, keeping the rows", async () => {
    await loadExtract(extract());
    const lines = extractLines().map((l) => l.replace('"familyKey":"70000001"', '"familyKey":"60000001"').replace('"score":8', '"score":9'));
    const next = await loadExtract(readExtract(lines));
    expect(next.written).toMatchObject({ documents: 0, documentsRefreshed: 2, links: 0, linksRefreshed: 1 });
    expect(next.notInDatabase.inventions).toBe(1);
    const doc = h.t.doc.find((d) => d.externalId === "us-90000001-b2")!;
    expect(doc.dedupKey).toBe("60000001");
    expect((doc.details as { familyKey: string }).familyKey).toBe("60000001");
    expect(h.t.link.map((l) => (l.evidence as { score: number }).score)).toEqual([10, 9, 4]);
    expect(h.t.doc).toHaveLength(4);
    expect(h.t.link).toHaveLength(3);
  });

  it("never deletes without prune, and leaves the other sources' documents alone", async () => {
    await loadExtract(extract());
    const dropped = readExtract(extractLines({ links: [{ t: "link", pmid: "111", doc: "us-90000001-b2", score: 10, where: "both" }] }));
    process.env.ETL_GUARD_BYPASS = "all";
    const summary = await loadExtract(dropped);
    expect(summary.pruned).toBeNull();
    expect(h.t.doc[0]).toEqual({ id: 900, source: "pubmed", externalId: "5550001", level: "guideline", dedupKey: "k" });
    expect(h.write.citingDocument.deleteMany).not.toHaveBeenCalled();
    expect(h.write.publicationCitingDocument.deleteMany).not.toHaveBeenCalled();
    expect(h.t.link).toHaveLength(3);
  });

  describe("pruning (the weekly refresh)", () => {
    const dropOne = () =>
      readExtract(
        extractLines({
          links: [
            { t: "link", pmid: "111", doc: "us-90000001-b2", score: 10, where: "both" },
            { t: "link", pmid: "111", doc: "us-2030900001-a1", score: 8, where: "body" },
          ],
        }),
      );

    it("deletes the links and documents the file no longer carries, and nothing of other sources", async () => {
      await loadExtract(extract());
      process.env.ETL_GUARD_BYPASS = "all"; // one of three is over the 20% guards
      const summary = await loadExtract(dropOne(), { prune: true });
      expect(summary.pruned).toEqual({ documents: 1, links: 1 });
      expect(summary.written).toMatchObject({ linksDeleted: 1, documentsDeleted: 1 });
      expect(h.t.doc.map((d) => d.externalId)).toEqual(["5550001", "us-90000001-b2", "us-2030900001-a1"]);
      expect(h.t.link.map((l) => l.pmid)).toEqual(["111", "111"]);
    });

    it("refuses a prune over 20% before any write, and a dry run reports it", async () => {
      await loadExtract(extract());
      h.t.openalex.length = 0;
      h.t.sql.length = 0;
      process.env.ETL_GUARD_BYPASS = "patent-citations:links,patent-citations:documents";
      await expect(loadExtract(dropOne(), { prune: true })).rejects.toThrow("patent-citations:prune-links");
      expect(h.t.link).toHaveLength(3);
      expect(h.t.openalex).toHaveLength(0);
      process.env.ETL_GUARD_BYPASS = "all";
      expect((await loadExtract(dropOne(), { prune: true, dryRun: true })).pruned).toEqual({ documents: 1, links: 1 });
      expect(h.t.link).toHaveLength(3);
    });

    it("deletes nothing when the file carries everything stored", async () => {
      await loadExtract(extract());
      const again = await loadExtract(extract(), { prune: true });
      expect(again.pruned).toEqual({ documents: 0, links: 0 });
      expect(h.write.publicationCitingDocument.deleteMany).not.toHaveBeenCalled();
    });
  });

  it("a dry run reports and writes nothing", async () => {
    const summary = await loadExtract(extract(), { dryRun: true });
    expect(summary.file.links).toBe(3);
    expect(summary.written).toBeNull();
    expect(h.t.doc).toHaveLength(1);
    expect(h.t.link).toHaveLength(0);
    expect(h.t.openalex).toHaveLength(0);
    expect(h.t.sql).toHaveLength(0);
  });

  describe("volume guards, each before any write", () => {
    const untouched = () => {
      expect(h.t.openalex).toHaveLength(0);
      expect(h.t.sql).toHaveLength(0);
    };

    it("refuses when the extract never considered too many of this database's publications", async () => {
      for (let i = 0; i < 10; i++) h.t.publication.push({ pmid: String(5000 + i) });
      await expect(loadExtract(extract())).rejects.toThrow(EtlGuardError);
      await expect(loadExtract(extract())).rejects.toThrow("patent-citations:publications-considered");
      untouched();
      expect(h.t.doc).toHaveLength(1);
    });

    it("lets a small gap through, and a wide one on the named bypass", async () => {
      // 98 of 100 publications here were never considered.
      for (let i = 0; i < 98; i++) h.t.publication.push({ pmid: `111${i}` });
      await expect(loadExtract(extract(), { dryRun: true })).rejects.toThrow(EtlGuardError);
      process.env.ETL_GUARD_BYPASS = "patent-citations:publications-considered";
      expect((await loadExtract(extract(), { dryRun: true })).unconsidered).toBe(98);
      delete process.env.ETL_GUARD_BYPASS;
      // 2 of 100: within the 2% allowed.
      h.t.publication.length = 2;
      for (let i = 0; i < 96; i++) h.t.publication.push({ pmid: "222" });
      h.t.publication.push({ pmid: "9001" }, { pmid: "9002" });
      expect((await loadExtract(extract(), { dryRun: true })).unconsidered).toBe(2);
    });

    it("refuses a file with far fewer links than the last load", async () => {
      await loadExtract(extract());
      h.t.openalex.length = 0;
      h.t.sql.length = 0;
      const short = readExtract(extractLines({ links: [{ t: "link", pmid: "111", doc: "us-90000001-b2", score: 10, where: "both" }] }));
      await expect(loadExtract(short)).rejects.toThrow(/patent-citations:(documents|links)/);
      untouched();
      expect(h.t.link).toHaveLength(3);
    });

    it("refuses a file with no usable link at all", async () => {
      const none = readExtract(extractLines({ links: [{ t: "link", pmid: "111", doc: "us-90000001-b2", score: 2, where: "both" }] }));
      await expect(loadExtract(none)).rejects.toThrow("below the 1 floor");
      untouched();
    });
  });
});
