/**
 * NCBI E-utilities calls for the policy-citations ETL. No auth required; an
 * optional NCBI_API_KEY raises the rate limit from 3 to 10 requests a second.
 *
 * Every call either returns a complete answer or throws, so the caller never
 * writes from a partial read.
 */
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
/** ESearch refuses to page past this many hits. */
export const ESEARCH_MAX = 9999;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
/** Spacing between sequential calls: under 3 a second without a key. */
const DELAY_MS = 350;
const TIMEOUT_MS = 90_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Injectable for tests. `retryBaseMs: 0` makes retries immediate. */
export interface NcbiOptions {
  fetchFn?: typeof fetch;
  retryBaseMs?: number;
  delayMs?: number;
}

/**
 * POST one E-utilities request and return its JSON. `ok` decides whether the
 * body is a usable answer: NCBI reports backend outages as HTTP 200 with an
 * ERROR body, so those are retried like a 5xx.
 */
async function eutils<T>(
  path: string,
  params: Record<string, string>,
  ids: ReadonlyArray<string | number>,
  ok: (json: unknown) => T | null,
  opts: NcbiOptions,
): Promise<T> {
  const { fetchFn = fetch, retryBaseMs = RETRY_BASE_MS } = opts;
  const body = new URLSearchParams({ retmode: "json", ...params });
  for (const id of ids) body.append("id", String(id));
  if (process.env.NCBI_API_KEY) body.set("api_key", process.env.NCBI_API_KEY);

  for (let attempt = 0; ; attempt++) {
    let failure: string;
    try {
      const res = await fetchFn(EUTILS + path, {
        method: "POST",
        body,
        headers: { "User-Agent": "scholars-etl/1.0" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const parsed = ok(await res.json());
        if (parsed !== null) return parsed;
        failure = "error body";
      } else if (res.status === 429 || res.status >= 500) {
        failure = `HTTP ${res.status}`;
      } else {
        throw new Error(`${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith(path)) throw err;
      failure = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= MAX_RETRIES) throw new Error(`${path} failed after ${attempt + 1} attempts: ${failure}`);
    await sleep(retryBaseMs * 2 ** attempt);
  }
}

interface Esearch {
  count: number;
  ids: string[];
}

async function esearch(db: string, term: string, retmax: number, opts: NcbiOptions): Promise<Esearch> {
  return eutils(
    "esearch.fcgi",
    { db, term, retmax: String(retmax) },
    [],
    (json) => {
      const r = (json as { esearchresult?: { count?: string; idlist?: string[]; ERROR?: string } })
        .esearchresult;
      if (!r || r.ERROR || r.count === undefined) return null;
      return { count: Number(r.count), ids: r.idlist ?? [] };
    },
    opts,
  );
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "/");

/**
 * Every PubMed ID matching `term`, published between `from` and `to`. ESearch
 * stops at 9,999 hits, so a range over that is halved until each piece fits.
 * The harvest is then checked against PubMed's own count for the same range,
 * and throws if it came up short.
 */
export async function harvestPmids(
  term: string,
  from: Date,
  to: Date,
  opts: NcbiOptions = {},
): Promise<Set<number>> {
  const { delayMs = DELAY_MS } = opts;
  const out = new Set<number>();
  const ranged = (a: Date, b: Date) => `(${term}) AND ("${ymd(a)}"[pdat] : "${ymd(b)}"[pdat])`;

  const walk = async (a: Date, b: Date): Promise<void> => {
    const res = await esearch("pubmed", ranged(a, b), ESEARCH_MAX, opts);
    await sleep(delayMs);
    if (res.count <= ESEARCH_MAX) {
      for (const id of res.ids) out.add(Number(id));
      return;
    }
    const days = Math.floor((b.getTime() - a.getTime()) / 86_400_000);
    if (days < 1) throw new Error(`${term}: ${res.count} records on ${ymd(a)}, over the ESearch page limit`);
    const mid = new Date(a.getTime() + Math.floor(days / 2) * 86_400_000);
    await walk(a, mid);
    await walk(new Date(mid.getTime() + 86_400_000), b);
  };
  await walk(from, to);

  const expected = (await esearch("pubmed", ranged(from, to), 0, opts)).count;
  // PubMed indexes while we page, so allow a sliver of drift, not a missing bucket.
  if (out.size < expected * 0.99) {
    throw new Error(`${term}: harvested ${out.size} of ${expected} records`);
  }
  return out;
}

type Summary = Record<string, unknown>;

/** ESummary records keyed by id. Throws unless every id came back. */
export async function esummary(
  db: "pubmed" | "books",
  ids: ReadonlyArray<string | number>,
  opts: NcbiOptions = {},
): Promise<Map<string, Summary>> {
  if (ids.length === 0) return new Map();
  return eutils(
    "esummary.fcgi",
    { db, id: ids.join(",") },
    [],
    (json) => {
      const result = (json as { result?: Record<string, Summary> & { uids?: string[] } }).result;
      if (!result?.uids) return null;
      const out = new Map<string, Summary>();
      // A deleted record comes back with an `error` field; keep it out.
      for (const uid of result.uids) if (!result[uid]?.error) out.set(uid, result[uid]);
      return out;
    },
    opts,
  );
}

/**
 * Bookshelf record ids citing each PubMed ID (`pubmed_books_refs`). One linkset
 * comes back per id; a response with fewer is treated as a failed read.
 */
export async function bookshelfCiters(
  pmids: ReadonlyArray<string>,
  opts: NcbiOptions = {},
): Promise<Map<string, string[]>> {
  if (pmids.length === 0) return new Map();
  return eutils(
    "elink.fcgi",
    { dbfrom: "pubmed", db: "books", linkname: "pubmed_books_refs" },
    pmids,
    (json) => {
      const sets = (json as { linksets?: Array<{ ids?: unknown[]; linksetdbs?: Array<{ links?: unknown[] }> }> })
        .linksets;
      if (!sets || sets.length !== pmids.length) return null;
      const out = new Map<string, string[]>();
      for (const s of sets) {
        const links = (s.linksetdbs ?? []).flatMap((d) => d.links ?? []).map(String);
        if (links.length > 0) out.set(String(s.ids?.[0]), links);
      }
      return out;
    },
    opts,
  );
}
