/**
 * DOI → PMID for the ORCID works that carry a DOI but no PMID (ORCID queue v2.1
 * spec, item 2). Measured on prod: of 6,968 distinct DOI-only preview works,
 * 55% resolve, so most "new works" were PubMed papers we simply could not see.
 *
 * Two NCBI lookups, in order:
 *   1. the PMC ID converter, `ids=<doi,…>&idtype=doi`, 200 DOIs per call
 *      (it knows PMC articles, plus some others);
 *   2. for what is left, PubMed ESearch `"<doi>"[aid] OR …`, ~40 DOIs per call,
 *      then ESummary on the hits to map each PMID back to its DOI through
 *      `articleids` (ESearch alone does not say which DOI matched which PMID).
 *
 * Exact only: a DOI two PMIDs claim is left unresolved. Rate limits as the
 * other E-utilities callers here (`etl/pubmed-retractions`, `etl/reciter/pubmed-titles`):
 * 3 req/s without a key, 10 with `NCBI_API_KEY`; 3 retries on a network error,
 * 429 or 5xx; a per-request timeout.
 *
 * NEVER throws. A failed batch leaves its DOIs unresolved and is counted; after
 * MAX_CONSECUTIVE_FAILURES failed batches in a row the resolver stops calling
 * NCBI for the rest of the run (an outage must not stall the weekly run with
 * hundreds of retried batches). The caller logs the counts and writes its
 * evidence regardless: an unresolved DOI only means the work shows as
 * "not in PubMed".
 *
 * Cached per resolver instance (one per run), so a DOI is looked up once.
 * The mapping is pure and exported; the fetcher is injectable for tests.
 */

const IDCONV = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/";
const ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const TOOL = "scholars-etl";

export const IDCONV_BATCH = 200;
export const AID_BATCH = 40;
const MAX_RETRIES = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const DELAY_NO_KEY_MS = 350;
const DELAY_KEY_MS = 110;
const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_BASE_MS = 1000;

export type FetchFn = typeof fetch;

export type ResolverOptions = {
  fetchFn?: FetchFn;
  apiKey?: string;
  /** Between calls; default from the key (350 ms without, 110 ms with). */
  delayMs?: number;
  timeoutMs?: number;
  /** Retry backoff base; tests pass 0. */
  retryBaseMs?: number;
};

export type ResolveStats = {
  requested: number;
  byIdconv: number;
  byAid: number;
  unresolved: number;
  failedBatches: number;
  /** True when the resolver stopped calling NCBI after repeated failures. */
  gaveUp: boolean;
};

/** A DOI as the lookups and the work index compare it: trimmed, lowercased,
 *  any `https://doi.org/` or `doi:` prefix removed. Null when it is not a DOI. Pure. */
export function normalizeDoi(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "");
  return /^10\.\d+(\.\d+)*\/\S+$/.test(d) ? d : null;
}

const pmidOf = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d+$/.test(s) && s !== "0" ? s : null;
};

/** The PMC ID converter's JSON → DOI → PMID, for the requested DOIs only. Pure. */
export function parseIdconv(json: unknown, requested: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const records = (json as { records?: unknown })?.records;
  if (!Array.isArray(records)) return out;
  for (const r of records as Array<Record<string, unknown>>) {
    const doi = normalizeDoi(
      (typeof r.doi === "string" && r.doi) || (r["requested-id"] as string | undefined),
    );
    const pmid = pmidOf(r.pmid);
    if (doi && pmid && requested.has(doi)) out.set(doi, pmid);
  }
  return out;
}

/** The ESearch term for a batch: `"<doi>"[aid] OR …`. Quotes inside a DOI
 *  would end the phrase, so such a DOI is left out (it stays unresolved). Pure. */
export function aidTerm(dois: readonly string[]): string {
  return dois
    .filter((d) => !d.includes('"'))
    .map((d) => `"${d}"[aid]`)
    .join(" OR ");
}

/** ESummary JSON → DOI → PMID through each record's `articleids`, for the
 *  requested DOIs only; a DOI two PMIDs carry is dropped (ambiguous). Pure. */
export function parseEsummaryDois(
  json: unknown,
  requested: ReadonlySet<string>,
): Map<string, string> {
  const result = (json as { result?: Record<string, unknown> })?.result;
  const claims = new Map<string, Set<string>>();
  if (!result || typeof result !== "object") return new Map();
  for (const [uid, doc] of Object.entries(result)) {
    if (uid === "uids" || !doc || typeof doc !== "object") continue;
    const pmid = pmidOf(uid);
    if (!pmid) continue;
    const ids = (doc as { articleids?: unknown }).articleids;
    if (!Array.isArray(ids)) continue;
    for (const a of ids as Array<{ idtype?: unknown; value?: unknown }>) {
      if (a?.idtype !== "doi" || typeof a.value !== "string") continue;
      const doi = normalizeDoi(a.value);
      if (!doi || !requested.has(doi)) continue;
      claims.set(doi, (claims.get(doi) ?? new Set()).add(pmid));
    }
  }
  const out = new Map<string, string>();
  for (const [doi, pmids] of claims) if (pmids.size === 1) out.set(doi, [...pmids][0]!);
  return out;
}

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();

const chunk = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * A per-run DOI → PMID resolver. `resolve` returns the PMIDs it found (cached
 * across calls) and never throws; `stats` holds the counts for the run's log.
 */
export function createPmidResolver(opts: ResolverOptions = {}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const apiKey = opts.apiKey?.trim() || undefined;
  const delayMs = opts.delayMs ?? (apiKey ? DELAY_KEY_MS : DELAY_NO_KEY_MS);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  /** DOI → PMID, or null when looked up and not found. */
  const cache = new Map<string, string | null>();
  const stats: ResolveStats = {
    requested: 0,
    byIdconv: 0,
    byAid: 0,
    unresolved: 0,
    failedBatches: 0,
    gaveUp: false,
  };
  let consecutive = 0;
  let calls = 0;

  /** One GET as JSON, with the shared retry rule; null = this batch failed. */
  async function getJson(url: string): Promise<unknown | null> {
    for (let attempt = 0; ; attempt++) {
      if (calls++ > 0) await sleep(delayMs);
      try {
        const res = await fetchFn(url, {
          headers: { "User-Agent": `${TOOL}/1.0`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return await res.json();
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (attempt + 1));
          continue;
        }
        return null;
      } catch {
        if (attempt < MAX_RETRIES) {
          await sleep(retryBaseMs * (attempt + 1));
          continue;
        }
        return null;
      }
    }
  }

  /** Runs one batch; false when it failed (and counts toward giving up). */
  async function batch(run: () => Promise<boolean>): Promise<void> {
    if (stats.gaveUp) return;
    const ok = await run();
    if (ok) {
      consecutive = 0;
      return;
    }
    stats.failedBatches++;
    if (++consecutive >= MAX_CONSECUTIVE_FAILURES) stats.gaveUp = true;
  }

  const params = (p: Record<string, string>) => {
    const q = new URLSearchParams({ ...p, tool: TOOL });
    if (apiKey) q.set("api_key", apiKey);
    return q.toString();
  };

  async function resolve(raw: Iterable<string>): Promise<Map<string, string>> {
    const wanted = [...new Set([...raw].map(normalizeDoi).filter((d): d is string => !!d))].filter(
      (d) => !cache.has(d),
    );
    stats.requested += wanted.length;
    const found = new Map<string, string>();

    // 1. PMC ID converter.
    for (const part of chunk(wanted, IDCONV_BATCH)) {
      await batch(async () => {
        const json = await getJson(
          `${IDCONV}?${params({ ids: part.join(","), idtype: "doi", format: "json" })}`,
        );
        if (json === null) return false;
        for (const [doi, pmid] of parseIdconv(json, new Set(part))) {
          found.set(doi, pmid);
          stats.byIdconv++;
        }
        return true;
      });
    }

    // 2. PubMed [aid] for the rest, mapped back through ESummary.
    const rest = wanted.filter((d) => !found.has(d));
    for (const part of chunk(rest, AID_BATCH)) {
      await batch(async () => {
        const term = aidTerm(part);
        if (!term) return true;
        const search = await getJson(
          `${ESEARCH}?${params({ db: "pubmed", term, retmode: "json", retmax: String(part.length * 3) })}`,
        );
        const ids = (search as { esearchresult?: { idlist?: unknown } } | null)?.esearchresult
          ?.idlist;
        if (search === null || !Array.isArray(ids)) return false;
        const pmids = ids.map(pmidOf).filter((p): p is string => !!p);
        if (pmids.length === 0) return true;
        const summary = await getJson(
          `${ESUMMARY}?${params({ db: "pubmed", id: pmids.join(","), retmode: "json" })}`,
        );
        if (summary === null) return false;
        for (const [doi, pmid] of parseEsummaryDois(summary, new Set(part))) {
          found.set(doi, pmid);
          stats.byAid++;
        }
        return true;
      });
    }

    // Cache only what a working lookup answered: a DOI a failed batch skipped
    // is not cached as "not found" (it is still unresolved for this run).
    for (const d of wanted) {
      if (found.has(d)) cache.set(d, found.get(d)!);
      else stats.unresolved++;
    }
    if (!stats.gaveUp && stats.failedBatches === 0)
      for (const d of wanted) if (!found.has(d)) cache.set(d, null);
    const out = new Map<string, string>();
    for (const d of [...raw].map(normalizeDoi)) {
      const hit = d ? cache.get(d) : null;
      if (d && hit) out.set(d, hit);
    }
    return out;
  }

  return { resolve, stats };
}
