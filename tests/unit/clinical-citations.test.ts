/** Clinical citations (etl:clinical-citations): the pure shaping, the level
 *  precedence shared with etl:policy-citations, and the loader against an
 *  in-memory client. That a stored clinical row changes nothing the existing
 *  readers show is proved beside the trials, in
 *  tests/unit/trial-citations.test.ts. PMIDs, people and titles are invented. */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The tables the loader touches, held in memory. */
const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const t = { doc: [] as Row[], link: [] as Row[], author: [] as Row[], sql: [] as string[] };
  let nextId = 1;
  const level = (l: Row) => t.doc.find((d) => d.id === l.citingDocumentId)!.level;
  const write = {
    citingDocument: {
      findMany: vi.fn(async ({ where }: { where: { source: string; externalId?: { in: string[] } } }) =>
        t.doc.filter(
          (d) => d.source === where.source && (!where.externalId || where.externalId.in.includes(d.externalId as string)),
        ),
      ),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        const taken = new Set(t.doc.map((d) => `${d.source}|${d.externalId}`));
        const fresh = data.filter((d) => !taken.has(`${d.source}|${d.externalId}`));
        t.doc.push(...fresh.map((d) => ({ ...d, id: nextId++ })));
        return { count: fresh.length };
      }),
    },
    publicationCitingDocument: {
      count: vi.fn(async () => t.link.filter((l) => level(l) === "clinical").length),
      findMany: vi.fn(async () =>
        t.link
          .filter((l) => level(l) === "clinical" && l.evidence)
          .map((l) => ({ ...l, citingDocument: t.doc.find((d) => d.id === l.citingDocumentId)! })),
      ),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        // The foreign key: a link needs its document.
        for (const l of data) if (!t.doc.some((d) => d.id === l.citingDocumentId)) throw new Error("no such document");
        const taken = new Set(t.link.map((l) => `${l.pmid}|${l.citingDocumentId}`));
        const fresh = data.filter((l) => !taken.has(`${l.pmid}|${l.citingDocumentId}`));
        t.link.push(...fresh.map((l) => ({ ...l })));
        return { count: fresh.length };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        Object.assign(t.link.find((l) => l.pmid === where.pmid && l.citingDocumentId === where.citingDocumentId)!, data);
      }),
    },
    publicationAuthor: { findMany: vi.fn(async () => t.author) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: Array<{ strings?: string[] }>) => {
      // Inline the one nested fragment (the count expression), as Prisma would.
      t.sql.push(strings.map((s, i) => s + (values[i]?.strings?.join("?") ?? "")).join("").replace(/\s+/g, " "));
      return 0;
    }),
    reset: () => {
      t.doc.length = t.link.length = t.author.length = t.sql.length = 0;
      nextId = 1;
    },
  };
  return { t, write };
});
vi.mock("@/lib/db", () => ({ db: { write: h.write } }));

import { loadClinicalCitations } from "@/etl/clinical-citations/load";
import { CLINICAL_COUNT_SQL, clinicalAction, clinicalDoc, isOwnWork } from "@/etl/clinical-citations/shape";
import { pubmedLevel, retypedLevel } from "@/etl/policy-citations/shape";
import { POLICY_LEVELS } from "@/lib/citations/policy-rollup";
import { EtlGuardError } from "@/lib/etl-guard";
import { Prisma } from "@/lib/generated/prisma/client";

const summary = (n: number) => ({
  title: `A randomized trial of <i>something</i>, number ${n}.`,
  pubdate: "2031 Mar 4",
  authors: [{ name: "Example A" }, { name: "Sample B" }],
  source: "J Ex Med",
  fulljournalname: "Journal of Example Medicine",
  volume: "12",
  issue: "3",
  pages: "45-67",
  articleids: [{ idtype: "doi", value: `10.5555/ex.${n}` }],
});

/** Sources over fixed links; `missing` have no PubMed record. */
function sources(links: Array<[number, number]>, missing: number[] = []) {
  const asked: number[] = [];
  return {
    asked,
    readLinks: vi.fn(async (cited: string[]) => links.filter(([c]) => cited.includes(String(c)))),
    summaries: vi.fn(async (pmids: number[]) => {
      asked.push(...pmids);
      return new Map(pmids.filter((p) => !missing.includes(p)).map((p) => [String(p), summary(p)]));
    }),
  };
}
const run = (pmids: string[], src: ReturnType<typeof sources> & { now?: () => number }, partial = false, budgetMin = 30) =>
  loadClinicalCitations(pmids, { partial, budgetMin }, src);
const linksOf = () => h.t.link.map((l) => `${l.pmid}>${h.t.doc.find((d) => d.id === l.citingDocumentId)!.externalId}`).sort();
const storeDoc = (externalId: string, level: string) => {
  const id = 9000 + h.t.doc.length;
  h.t.doc.push({ id, source: "pubmed", externalId, level, title: "Stored", dedupKey: `stored|${externalId}` });
  return id;
};

beforeEach(() => {
  h.write.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("clinical shaping", () => {
  it("stores a citing article as a PubMed document at level clinical, citation and all", () => {
    expect(clinicalDoc(777, summary(777))).toEqual({
      source: "pubmed",
      externalId: "777",
      title: "A randomized trial of something, number 777.",
      year: 2031,
      url: "https://pubmed.ncbi.nlm.nih.gov/777/",
      level: "clinical",
      issuingBody: null,
      dedupKey: "a randomized trial of something number 777|2031",
      authors: "Example A, Sample B",
      journal: "Journal of Example Medicine",
      journalAbbrev: "J Ex Med",
      volume: "12",
      issue: "3",
      pages: "45-67",
      doi: "10.5555/ex.777",
      publisher: null,
    });
  });

  it("own work: the two papers share a confirmed WCM author", () => {
    const a = new Set(["aaa1001", "bbb1002"]);
    expect(isOwnWork(a, new Set(["bbb1002"]))).toBe(true);
    expect(isOwnWork(a, new Set(["ccc1003"]))).toBe(false);
    // A citing article we do not hold has no confirmed authors.
    expect(isOwnWork(a, undefined)).toBe(false);
    expect(isOwnWork(undefined, a)).toBe(false);
  });
});

describe("level precedence: one article, one row, one level", () => {
  it("clinical is not a ranked level", () => {
    expect([...POLICY_LEVELS]).not.toContain("clinical");
  });

  it("this import fetches what is not stored, links what is clinical, and leaves every other level alone", () => {
    expect(clinicalAction(undefined)).toBe("fetch");
    expect(clinicalAction("clinical")).toBe("link");
    for (const level of ["authority", "guideline", "consensus", "review", "trial", "patent"]) {
      expect(clinicalAction(level)).toBe("skip");
    }
  });

  it("the policy import moves a stored clinical article up to the level PubMed types it at", () => {
    expect(retypedLevel("clinical", "guideline")).toBe("guideline");
    expect(retypedLevel("clinical", "consensus")).toBe("consensus");
    expect(retypedLevel("clinical", "review")).toBe("review");
    // A review later typed as a guideline moves too; an article of no type stays put.
    expect(retypedLevel("review", "guideline")).toBe("guideline");
    expect(retypedLevel("guideline", "guideline")).toBeNull();
    expect(retypedLevel("clinical", null)).toBeNull();
    expect(retypedLevel("guideline", null)).toBeNull();
  });

  it("an article of two types is retyped to the stronger one", () => {
    const sets = { guideline: new Set([5]), consensus: new Set<number>(), review: new Set([5, 6]) };
    expect(retypedLevel("clinical", pubmedLevel(5, sets))).toBe("guideline");
    expect(retypedLevel("clinical", pubmedLevel(6, sets))).toBe("review");
    expect(retypedLevel("clinical", pubmedLevel(7, sets))).toBeNull();
  });

  it("a stored guideline stays a guideline and gets no link from here", async () => {
    const guideline = storeDoc("501", "guideline");
    h.t.link.push({ pmid: "111", citingDocumentId: guideline });
    const src = sources([
      [111, 501],
      [222, 501],
      [111, 502],
    ]);
    const out = await run(["111", "222"], src);
    expect(src.asked).toEqual([502]);
    expect(h.t.doc.map((d) => [d.externalId, d.level])).toEqual([
      ["501", "guideline"],
      ["502", "clinical"],
    ]);
    // 222>501 is in the source and is not written: the guideline's links are the policy import's.
    expect(linksOf()).toEqual(["111>501", "111>502"]);
    expect(out.citing).toMatchObject({ atAnotherLevel: 1, fresh: 1, fetched: 1 });
    expect(out.linksAdded).toBe(1);
  });

  it("after the policy import retypes a clinical row, the next run leaves it and its links alone", async () => {
    const src = sources([[111, 601]]);
    await run(["111"], src);
    const doc = h.t.doc.find((d) => d.externalId === "601")!;
    expect(doc.level).toBe("clinical");
    // What pass 1 of etl:policy-citations does with `retypedLevel`.
    doc.level = retypedLevel("clinical", "review");
    const again = sources([
      [111, 601],
      [222, 601],
    ]);
    const out = await run(["111", "222"], again);
    expect(again.asked).toEqual([]);
    expect(h.t.doc).toHaveLength(1);
    expect(h.t.doc[0].level).toBe("review");
    expect(linksOf()).toEqual(["111>601"]);
    expect(out.linksAdded).toBe(0);
  });
});

describe("the load", () => {
  it("asks PubMed only about citing articles not stored, and a second run asks about none", async () => {
    const links: Array<[number, number]> = [
      [111, 701],
      [111, 702],
      [222, 702],
    ];
    const first = sources(links);
    expect((await run(["111", "222"], first)).linksAdded).toBe(3);
    expect(first.asked).toEqual([701, 702]);
    const second = sources([...links, [222, 701]]);
    const out = await run(["111", "222"], second);
    expect(second.asked).toEqual([]);
    // A stored article citing a paper it did not cite before: the link alone is added.
    expect(out.linksAdded).toBe(1);
    expect(h.t.doc).toHaveLength(2);
    expect(linksOf()).toEqual(["111>701", "111>702", "222>701", "222>702"]);
  });

  it("writes no link for a citing article PubMed has no record of, and asks again next run", async () => {
    const links: Array<[number, number]> = [
      [111, 801],
      [111, 802],
    ];
    const out = await run(["111"], sources(links, [802]));
    expect(out.citing).toMatchObject({ fetched: 1, noRecord: 1, waiting: 0 });
    expect(linksOf()).toEqual(["111>801"]);
    const again = sources(links);
    await run(["111"], again);
    expect(again.asked).toEqual([802]);
    expect(linksOf()).toEqual(["111>801", "111>802"]);
  });

  it("every link written points at a stored clinical document", async () => {
    storeDoc("901", "review");
    await run(["111", "222"], sources([[111, 901], [111, 902], [222, 903], [222, 904]], [904]));
    expect(h.t.link.length).toBe(2);
    for (const l of h.t.link) expect(h.t.doc.find((d) => d.id === l.citingDocumentId)!.level).toBe("clinical");
  });

  it("stops fetching when the budget runs out, keeps what it has, and the next run continues", async () => {
    const links = Array.from({ length: 450 }, (_, i): [number, number] => [111, 1000 + i]);
    // The clock passes the one-minute budget after the first PubMed call.
    let t = 0;
    const src = { ...sources(links), now: () => t };
    src.summaries.mockImplementationOnce(async (pmids: number[]) => {
      t = 61_000;
      return new Map(pmids.map((p) => [String(p), summary(p)]));
    });
    const out = await run(["111"], src, false, 1);
    expect(src.summaries).toHaveBeenCalledTimes(1);
    expect(out.citing).toMatchObject({ fresh: 450, fetched: 200, waiting: 250 });
    expect(h.t.doc).toHaveLength(200);
    expect(h.t.link).toHaveLength(200);
    // The rollup still ran, over what is stored.
    expect(h.t.sql).toHaveLength(1);

    const rest = sources(links);
    const next = await run(["111"], rest);
    expect(rest.asked).toHaveLength(250);
    expect(Math.min(...rest.asked)).toBe(1200);
    expect(next.citing).toMatchObject({ stored: 200, fresh: 250, fetched: 250, waiting: 0 });
    expect(h.t.link).toHaveLength(450);
  });

  it("a PubMed failure writes nothing for that batch and fails the run", async () => {
    const src = sources([[111, 1101]]);
    src.summaries.mockRejectedValueOnce(new Error("esummary.fcgi failed after 6 attempts: HTTP 502"));
    await expect(run(["111"], src)).rejects.toThrow("esummary.fcgi failed");
    expect(h.t.doc).toHaveLength(0);
    expect(h.t.link).toHaveLength(0);
  });

  it("a PubMed failure after a written group still flags own work and rolls up, then fails the run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // 1,200 new citing articles: the first group of five PubMed calls is written, the sixth call fails.
    const links = Array.from({ length: 1200 }, (_, i): [number, number] => [111, 2000 + i]);
    // A link stored earlier whose shared authorship has since been confirmed.
    h.t.link.push({ pmid: "111", citingDocumentId: storeDoc("1999", "clinical") });
    h.t.author.push({ pmid: "111", cwid: "aaa1001" }, { pmid: "1999", cwid: "aaa1001" });
    const src = sources([[111, 1999], ...links]);
    for (let i = 0; i < 5; i++) {
      src.summaries.mockImplementationOnce(async (pmids: number[]) => new Map(pmids.map((p) => [String(p), summary(p)])));
    }
    src.summaries.mockRejectedValueOnce(new Error("esummary.fcgi failed after 6 attempts: HTTP 502"));

    await expect(run(["111"], src)).rejects.toThrow("esummary.fcgi failed");
    expect(src.summaries).toHaveBeenCalledTimes(6);
    // The first group stayed, with its links.
    expect(h.t.doc).toHaveLength(1001);
    expect(h.t.link).toHaveLength(1001);
    expect(h.t.link.find((l) => l.citingDocumentId === h.t.doc[0].id)!.evidence).toEqual({ ownWork: true });
    expect(h.t.sql).toHaveLength(1);
    expect(h.t.sql[0]).toContain("SET p.clinical_cite_count =");

    // The next run fetches only what the failed one did not store.
    const rest = sources([[111, 1999], ...links]);
    await expect(run(["111"], rest)).resolves.toMatchObject({ citing: { fresh: 200, fetched: 200, waiting: 0 } });
    expect(h.t.link).toHaveLength(1201);
  });
});

describe("a bad reciterdb read", () => {
  const seed = async () => {
    await run(["111"], sources(Array.from({ length: 10 }, (_, i): [number, number] => [111, 1300 + i])));
    h.t.sql.length = 0;
    h.write.publicationCitingDocument.createMany.mockClear();
  };
  const untouched = () => {
    expect(h.t.doc).toHaveLength(10);
    expect(h.t.link).toHaveLength(10);
    // No rollup: a count is never recomputed from a read that was refused.
    expect(h.t.sql).toHaveLength(0);
    expect(h.write.publicationCitingDocument.createMany).not.toHaveBeenCalled();
  };

  it("an empty read over the whole corpus throws before any write", async () => {
    await seed();
    await expect(run(["111"], sources([]))).rejects.toThrow("analysis_nih_cites_clin returned no citation links");
    untouched();
  });

  it("a failed read throws before any write", async () => {
    await seed();
    const src = sources([]);
    src.readLinks.mockRejectedValueOnce(new Error("connect ETIMEDOUT"));
    await expect(run(["111"], src)).rejects.toThrow("ETIMEDOUT");
    untouched();
  });

  it("a read under half the stored links is refused", async () => {
    await seed();
    await expect(run(["111"], sources([[111, 1300], [111, 1301]]))).rejects.toThrow(EtlGuardError);
    untouched();
  });

  it("a spot check of a paper nothing clinical cites is an answer, and writes nothing", async () => {
    await seed();
    const out = await run(["333"], sources([]), true);
    expect(out).toMatchObject({ links: 0, linksAdded: 0 });
    untouched();
  });

  it("a spot check is not held to the whole corpus's volume", async () => {
    await seed();
    await expect(run(["111"], sources([[111, 1300]]), true)).resolves.toMatchObject({ linksAdded: 0 });
  });
});

describe("own work", () => {
  const authors = (...rows: Array<[string, string]>) => h.t.author.push(...rows.map(([pmid, cwid]) => ({ pmid, cwid })));
  const evidence = () => Object.fromEntries(h.t.link.map((l) => [`${l.pmid}>${h.t.doc.find((d) => d.id === l.citingDocumentId)!.externalId}`, l.evidence ?? null]));

  it("asks for confirmed WCM authorships, as the trials pass does", async () => {
    await run(["111"], sources([[111, 1401]]));
    expect(h.write.publicationAuthor.findMany).toHaveBeenCalledWith({
      where: { isConfirmed: true, cwid: { not: null } },
      select: { pmid: true, cwid: true },
    });
  });

  it("stores and flags a citing article of ours that shares an author with the paper", async () => {
    // 1401 is ours and shares an author with 111; 1402 is ours with other authors; 1403 is not ours.
    authors(["111", "aaa1001"], ["111", "bbb1002"], ["1401", "bbb1002"], ["1402", "ccc1003"], ["222", "ccc1003"]);
    const out = await run(["111", "222"], sources([[111, 1401], [111, 1402], [111, 1403], [222, 1401]]));
    expect(evidence()).toEqual({
      "111>1401": { ownWork: true },
      "111>1402": null,
      "111>1403": null,
      "222>1401": null,
    });
    expect(out.ownWork).toBe(1);
    expect(out.linksAdded).toBe(4);
  });

  it("flags a stored link when the shared authorship is confirmed later, and clears it when it goes", async () => {
    authors(["111", "aaa1001"]);
    const links: Array<[number, number]> = [[111, 1501]];
    await run(["111"], sources(links));
    expect(evidence()).toEqual({ "111>1501": null });

    authors(["1501", "aaa1001"]);
    expect((await run(["111"], sources(links))).ownWork).toBe(1);
    expect(evidence()).toEqual({ "111>1501": { ownWork: true } });

    h.t.author.pop();
    expect((await run(["111"], sources(links))).ownWork).toBe(0);
    expect(evidence()).toEqual({ "111>1501": Prisma.DbNull });
  });

  it("a partial run clears no flag on a link it did not read", async () => {
    authors(["111", "aaa1001"], ["1601", "aaa1001"], ["222", "bbb1002"]);
    await run(["111", "222"], sources([[111, 1601], [222, 1602]]));
    h.t.author.length = 0;
    await run(["222"], sources([[222, 1602]]), true);
    expect(evidence()["111>1601"]).toEqual({ ownWork: true });
  });
});

describe("the count leaves out own work", () => {
  const flat = (sql: Prisma.Sql) => sql.strings.join("?").replace(/\s+/g, " ");

  it("counts clinical documents whose link is not flagged ownWork, one per article", () => {
    expect(flat(CLINICAL_COUNT_SQL)).toBe(
      "COUNT(DISTINCT CASE WHEN d.level = 'clinical' AND COALESCE(JSON_CONTAINS(l.evidence, 'true', '$.ownWork'), 0) = 0 THEN d.id END)",
    );
  });

  it("the load writes clinical_cite_count from that expression, and no other column", async () => {
    await run(["111"], sources([[111, 1701]]));
    expect(h.t.sql).toHaveLength(1);
    const sql = h.t.sql[0];
    expect(sql).toContain(`SELECT l.pmid, ${flat(CLINICAL_COUNT_SQL)} AS cc`);
    expect(sql).toContain("WHERE d.level = 'clinical' GROUP BY l.pmid");
    expect(sql).toContain("SET p.clinical_cite_count = COALESCE(x.cc, 0) WHERE p.clinical_cite_count <> COALESCE(x.cc, 0)");
    expect(sql.match(/p\.\w+ =/g)).toEqual(["p.clinical_cite_count ="]);
  });
});
