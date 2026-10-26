/**
 * `etl/orcid-evidence/pubmed-resolve` — DOI → PMID for ORCID works (ORCID queue
 * v2.1 spec, item 2): the pure mapping of the PMC ID converter and ESummary
 * replies, the ESearch term, and the resolver's batching, caching and outage
 * rule (a failed lookup leaves DOIs unresolved and never throws). `fetch` is a
 * mock: no NCBI call leaves the test. Synthetic DOIs and PMIDs.
 */
import { describe, expect, it, vi } from "vitest";

import {
  AID_BATCH,
  aidTerm,
  createPmidResolver,
  IDCONV_BATCH,
  normalizeDoi,
  parseEsummaryDois,
  parseIdconv,
  type FetchFn,
} from "@/etl/orcid-evidence/pubmed-resolve";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const idconv = (records: Array<Record<string, unknown>>) => json({ status: "ok", records });
const esearch = (ids: string[]) =>
  json({ esearchresult: { count: String(ids.length), idlist: ids } });
const esummary = (docs: Record<string, string[]>) =>
  json({
    result: {
      uids: Object.keys(docs),
      ...Object.fromEntries(
        Object.entries(docs).map(([uid, dois]) => [
          uid,
          { uid, articleids: dois.map((value) => ({ idtype: "doi", value })) },
        ]),
      ),
    },
  });

/** A fake NCBI: answers by endpoint from the given tables. */
function fakeNcbi(opts: {
  pmc?: Record<string, string>;
  pubmed?: Record<string, string>;
  fail?: (url: URL) => Response | Error | null;
}) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    const failure = opts.fail?.(url);
    if (failure instanceof Error) throw failure;
    if (failure) return failure;
    if (url.pathname.includes("idconv")) {
      const ids = url.searchParams.get("ids")!.split(",");
      return idconv(
        ids.map((d) =>
          opts.pmc?.[d.toLowerCase()]
            ? { doi: d, pmid: Number(opts.pmc[d.toLowerCase()]), "requested-id": d }
            : { "requested-id": d, status: "error", errmsg: "Identifier not found in PMC" },
        ),
      );
    }
    if (url.pathname.endsWith("esearch.fcgi")) {
      const term = url.searchParams.get("term")!;
      const dois = [...term.matchAll(/"([^"]+)"\[aid\]/g)].map((m) => m[1]!);
      return esearch(dois.map((d) => opts.pubmed?.[d]).filter((x): x is string => !!x));
    }
    if (url.pathname.endsWith("esummary.fcgi")) {
      const ids = url.searchParams.get("id")!.split(",");
      const docs: Record<string, string[]> = {};
      for (const [d, p] of Object.entries(opts.pubmed ?? {}))
        if (ids.includes(p)) docs[p] = [...(docs[p] ?? []), d.toUpperCase()];
      return esummary(docs);
    }
    return json({}, 404);
  });
  return { fn: fn as unknown as FetchFn, calls };
}

const fast = { delayMs: 0, retryBaseMs: 0 };

describe("pure mapping", () => {
  it("normalizeDoi lowercases and strips doi.org / doi: prefixes; rejects non-DOIs", () => {
    expect(normalizeDoi(" https://doi.org/10.1000/ABC ")).toBe("10.1000/abc");
    expect(normalizeDoi("doi:10.1000/x")).toBe("10.1000/x");
    expect(normalizeDoi("http://dx.doi.org/10.1000/x")).toBe("10.1000/x");
    expect(normalizeDoi("not a doi")).toBeNull();
    expect(normalizeDoi(null)).toBeNull();
  });

  it("parseIdconv keeps found records for requested DOIs, skips errors", () => {
    const m = parseIdconv(
      {
        records: [
          { doi: "10.1/A", pmid: 123, "requested-id": "10.1/A" },
          { "requested-id": "10.1/b", status: "error" },
          { doi: "10.1/c", pmid: "456" },
          { doi: "10.1/not-asked", pmid: 9 },
        ],
      },
      new Set(["10.1/a", "10.1/b", "10.1/c"]),
    );
    expect([...m]).toEqual([
      ["10.1/a", "123"],
      ["10.1/c", "456"],
    ]);
    expect(parseIdconv({ status: "error" }, new Set(["10.1/a"])).size).toBe(0);
  });

  it("aidTerm ORs quoted [aid] phrases and skips a DOI with a quote", () => {
    expect(aidTerm(["10.1/a", '10.1/b"x', "10.1/c"])).toBe('"10.1/a"[aid] OR "10.1/c"[aid]');
  });

  it("parseEsummaryDois maps back through articleids and drops a DOI two PMIDs claim", () => {
    const m = parseEsummaryDois(
      {
        result: {
          uids: ["1", "2", "3"],
          "1": {
            articleids: [
              { idtype: "pubmed", value: "1" },
              { idtype: "doi", value: "10.1/A" },
            ],
          },
          "2": { articleids: [{ idtype: "doi", value: "10.1/dup" }] },
          "3": { articleids: [{ idtype: "doi", value: "10.1/DUP" }] },
        },
      },
      new Set(["10.1/a", "10.1/dup"]),
    );
    expect([...m]).toEqual([["10.1/a", "1"]]);
  });
});

describe("createPmidResolver", () => {
  it("PMC ID converter first, PubMed [aid] for the rest; unknown DOIs stay unresolved", async () => {
    const { fn, calls } = fakeNcbi({
      pmc: { "10.1/pmc": "111" },
      pubmed: { "10.1/pubmed": "222" },
    });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    const got = await r.resolve(["10.1/PMC", "https://doi.org/10.1/pubmed", "10.1/nowhere"]);
    expect([...got].sort()).toEqual([
      ["10.1/nowhere", null],
      ["10.1/pmc", "111"],
      ["10.1/pubmed", "222"],
    ]);
    expect(r.stats).toMatchObject({ requested: 3, byIdconv: 1, byAid: 1, unresolved: 1 });
    expect(calls.map((u) => u.pathname.split("/").filter(Boolean).pop())).toEqual([
      "articles",
      "esearch.fcgi",
      "esummary.fcgi",
    ]);
    // The [aid] search only asks for what the converter did not find.
    expect(calls[1]!.searchParams.get("term")).toBe('"10.1/pubmed"[aid] OR "10.1/nowhere"[aid]');
  });

  it("batches 200 per converter call and 40 per [aid] search", async () => {
    const dois = Array.from({ length: 450 }, (_, i) => `10.9/${i}`);
    const { fn, calls } = fakeNcbi({});
    await createPmidResolver({ fetchFn: fn, ...fast }).resolve(dois);
    const conv = calls.filter((u) => u.pathname.includes("idconv"));
    const search = calls.filter((u) => u.pathname.endsWith("esearch.fcgi"));
    expect(conv.map((u) => u.searchParams.get("ids")!.split(",").length)).toEqual([
      IDCONV_BATCH,
      IDCONV_BATCH,
      50,
    ]);
    expect(search).toHaveLength(Math.ceil(450 / AID_BATCH));
    // No hits = no ESummary call.
    expect(calls.some((u) => u.pathname.endsWith("esummary.fcgi"))).toBe(false);
  });

  it("caches per run: a DOI looked up once is not asked again", async () => {
    const { fn, calls } = fakeNcbi({ pmc: { "10.1/a": "1" } });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    await r.resolve(["10.1/a", "10.1/b"]);
    const before = calls.length;
    const again = await r.resolve(["10.1/A", "10.1/b"]);
    expect(calls.length).toBe(before);
    expect([...again]).toEqual([
      ["10.1/a", "1"],
      ["10.1/b", null],
    ]);
  });

  it("sends the api key when configured, and never without one", async () => {
    const a = fakeNcbi({});
    await createPmidResolver({ fetchFn: a.fn, apiKey: "k123", ...fast }).resolve(["10.1/a"]);
    expect(a.calls.every((u) => u.searchParams.get("api_key") === "k123")).toBe(true);
    const b = fakeNcbi({});
    await createPmidResolver({ fetchFn: b.fn, ...fast }).resolve(["10.1/a"]);
    expect(b.calls.some((u) => u.searchParams.has("api_key"))).toBe(false);
  });

  it("retries a 429 / 5xx, then succeeds", async () => {
    let n = 0;
    const { fn } = fakeNcbi({
      pmc: { "10.1/a": "7" },
      fail: (u) => (u.pathname.includes("idconv") && n++ < 2 ? json({}, 503) : null),
    });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    expect([...(await r.resolve(["10.1/a"]))]).toEqual([["10.1/a", "7"]]);
    expect(r.stats.failedBatches).toBe(0);
  });

  it("an outage never throws: DOIs stay unresolved, and it stops calling each host after 3 failed batches", async () => {
    const dois = Array.from({ length: 1000 }, (_, i) => `10.9/${i}`);
    const { fn, calls } = fakeNcbi({ fail: () => new Error("ECONNRESET") });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    const got = await r.resolve(dois);
    expect(got.size).toBe(0);
    expect(r.stats).toMatchObject({ unresolved: 1000, failedBatches: 6, gaveUp: true });
    // Per host (converter, then E-utilities): 3 batches × (1 try + 3 retries);
    // nothing after giving up.
    expect(calls).toHaveLength(24);
  });

  it("a failed batch is not cached as not-found", async () => {
    let down = true;
    const { fn } = fakeNcbi({
      pmc: { "10.1/a": "5" },
      fail: () => (down ? json({}, 400) : null),
    });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    expect((await r.resolve(["10.1/a"])).size).toBe(0);
    down = false;
    expect([...(await r.resolve(["10.1/a"]))]).toEqual([["10.1/a", "5"]]);
  });

  it("a DOI no lookup answered is absent (unknown), not null (not in PubMed)", async () => {
    // The converter answers; every [aid] search fails: the converter not
    // knowing a DOI says nothing about PubMed.
    const { fn } = fakeNcbi({
      pmc: { "10.1/a": "5" },
      fail: (u) => (u.pathname.endsWith("esearch.fcgi") ? new Error("ECONNRESET") : null),
    });
    const got = await createPmidResolver({ fetchFn: fn, ...fast }).resolve(["10.1/a", "10.1/b"]);
    expect([...got]).toEqual([["10.1/a", "5"]]);
    expect(got.has("10.1/b")).toBe(false);
  });

  it("a converter outage still lets PubMed [aid] run: giving up is per host", async () => {
    const dois = Array.from({ length: 600 }, (_, i) => `10.9/${i}`);
    const { fn, calls } = fakeNcbi({
      pubmed: { "10.9/1": "11", "10.9/599": "99" },
      fail: (u) => (u.pathname.includes("idconv") ? json({}, 503) : null),
    });
    const r = createPmidResolver({ fetchFn: fn, ...fast });
    const got = await r.resolve(dois);
    expect(got.get("10.9/1")).toBe("11");
    expect(got.get("10.9/599")).toBe("99");
    expect(got.get("10.9/2")).toBeNull();
    expect(got.size).toBe(600);
    expect(r.stats).toMatchObject({ byIdconv: 0, byAid: 2, failedBatches: 3, gaveUp: true });
    // 3 converter batches × 4 tries, then every [aid] batch.
    expect(calls.filter((u) => u.pathname.includes("idconv"))).toHaveLength(12);
    expect(calls.filter((u) => u.pathname.endsWith("esearch.fcgi"))).toHaveLength(
      Math.ceil(600 / AID_BATCH),
    );
  });
});
