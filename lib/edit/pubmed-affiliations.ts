/**
 * Does a publication have an author outside WCM? Read from the author
 * affiliations in PubMed's EFetch XML, for the collaborative publication
 * matrix's inter-institutional column (`center_publication_relevance.
 * external_author`, written by `etl/center-pub-relevance`). SPS stores only
 * its own (WCM) authors, and ReCiterDB keeps an affiliation for the target
 * author only, so PubMed is the one source with every author's.
 *
 * An author is WCM when any of their affiliations passes isWcmAffiliation; a
 * publication is external when some author lists affiliations and none is
 * WCM. An author with no affiliation decides nothing. Changing the matcher
 * once flags are stored means they must be recomputed: a data migration that
 * sets `external_author` back to NULL, and the ETL asks PubMed again.
 */
import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";

const EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
/** IDs per EFetch POST; NCBI recommends no more than 200 per request. */
const ID_BATCH = 200;
/** Under the keyless 3 req/s limit. */
const DELAY_MS = 350;

/**
 * Weill Cornell Medicine only, incl. WCM-Qatar, the Weill Cornell Graduate
 * School, the Meyer Cancer Center and the Englander Institute. Everyone else is
 * outside WCM (Jackie, 2026-10-29, Q1), including NewYork-Presbyterian, MSK,
 * Rockefeller and Cornell's Ithaca campus. An affiliation that names Weill
 * Cornell anywhere ("NewYork-Presbyterian/Weill Cornell Medical Center") reads
 * as WCM.
 */
const WCM_AFFILIATION =
  /weill[\s-]+cornell|weill\s+medical\s+college|meyer\s+cancer\s+cent(er|re)|englander\s+institute/i;
/** "Cornell University" in New York City is WCM; Ithaca is not. */
const CORNELL = /cornell\s+university/i;
const NYC = /new\s+york,\s*(ny|new\s+york)\b|\b100(65|21)\b/i;

export function isWcmAffiliation(a: string): boolean {
  return WCM_AFFILIATION.test(a) || (CORNELL.test(a) && NYC.test(a) && !/ithaca/i.test(a));
}

const text = (el: XmlElement) => (el.textContent ?? "").trim();

/**
 * pmid → true (an author lists only non-WCM affiliations), false (every
 * author with an affiliation has a WCM one), or null (no author lists one).
 */
export function externalAuthorFlags(xml: string): Map<string, boolean | null> {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const out = new Map<string, boolean | null>();
  for (const article of Array.from(doc.getElementsByTagName("PubmedArticle"))) {
    // The first PMID is MedlineCitation's own; later ones are cited references.
    const pmid = article.getElementsByTagName("PMID")[0];
    if (!pmid) continue;
    let flag: boolean | null = null;
    const list = article.getElementsByTagName("AuthorList")[0];
    for (const author of list ? Array.from(list.getElementsByTagName("Author")) : []) {
      const affs = Array.from(author.getElementsByTagName("Affiliation")).map(text).filter(Boolean);
      if (affs.length === 0) continue;
      if (affs.some(isWcmAffiliation)) flag ??= false;
      else {
        flag = true;
        break;
      }
    }
    out.set(text(pmid), flag);
  }
  return out;
}

/** EFetch the PMIDs in batches; a PMID PubMed does not return is absent. */
export async function fetchExternalAuthorFlags(
  pmids: ReadonlyArray<string>,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  for (let i = 0; i < pmids.length; i += ID_BATCH) {
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    const body = new URLSearchParams({
      db: "pubmed",
      retmode: "xml",
      id: pmids.slice(i, i + ID_BATCH).join(","),
    });
    if (process.env.NCBI_API_KEY) body.set("api_key", process.env.NCBI_API_KEY);
    const res = await fetchFn(EFETCH, {
      method: "POST",
      body,
      headers: { "User-Agent": "scholars-etl/1.0" },
    });
    if (!res.ok) throw new Error(`EFetch ${res.status}`);
    for (const [k, v] of externalAuthorFlags(await res.text())) out.set(k, v);
  }
  return out;
}

/** A record EFetch returns for a PMID: a journal article, or a Bookshelf
 *  chapter (`PubmedBookArticle`), which carries its authors the same way. */
const RECORD_TAGS = ["PubmedArticle", "PubmedBookArticle"] as const;

function affiliationsInDocument(doc: ReturnType<DOMParser["parseFromString"]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const tag of RECORD_TAGS) {
    for (const article of Array.from(doc.getElementsByTagName(tag))) {
      // The first PMID is the record's own; later ones are cited references.
      const pmid = article.getElementsByTagName("PMID")[0];
      if (!pmid) continue;
      const affiliations: string[] = [];
      for (const list of Array.from(article.getElementsByTagName("AuthorList"))) {
        for (const author of Array.from(list.getElementsByTagName("Author"))) {
          for (const aff of Array.from(author.getElementsByTagName("Affiliation"))) {
            const value = text(aff);
            if (value) affiliations.push(value);
          }
        }
      }
      out.set(text(pmid), affiliations);
    }
  }
  return out;
}

/** pmid -> every author's affiliations, as PubMed prints them. A PMID with no
 *  affiliation at all maps to an empty list. */
export function authorAffiliationsByPmid(xml: string): Map<string, string[]> {
  return affiliationsInDocument(new DOMParser().parseFromString(xml, "text/xml"));
}

/**
 * {@link authorAffiliationsByPmid} for an EFetch answer that must be one:
 * throws unless the body is a well-formed `PubmedArticleSet`. An error
 * document, an HTML page or a cut-off body answered with a 200 is a failure,
 * never "no records".
 */
function parseEfetchAnswer(xml: string): Map<string, string[]> {
  let doc: ReturnType<DOMParser["parseFromString"]>;
  let broken = false;
  try {
    doc = new DOMParser({
      onError: (level) => {
        if (level !== "warning") broken = true;
      },
    }).parseFromString(xml, "text/xml");
  } catch {
    throw new Error("EFetch answer is not XML");
  }
  if (broken) throw new Error("EFetch answer is not well-formed XML");
  if (doc.documentElement?.nodeName !== "PubmedArticleSet") {
    throw new Error("EFetch answer is not a PubmedArticleSet");
  }
  return affiliationsInDocument(doc);
}

/** With an API key NCBI allows 10 requests a second, else 3. */
const KEYED_DELAY_MS = 110;
/** Requests in flight at once. Their starts are still spaced by the delay, so
 *  the rate limit holds; this only stops a slow answer holding up the next. */
const AFFILIATION_FETCH_CONCURRENCY = 3;
/** The whole lookup, all batches: it runs inside an editor's save request,
 *  which the edge cuts off at 30 seconds. */
export const AFFILIATION_FETCH_TIMEOUT_MS = 20_000;

export type AuthorAffiliationLookup = {
  /** pmid -> every author's affiliations, for each PMID PubMed answered for.
   *  A PMID PubMed has no record of (asked twice) maps to an empty list. A
   *  PMID with no entry was NOT looked up: nothing is known about it. */
  affiliations: Map<string, string[]>;
  /** Every requested PMID has an entry. */
  complete: boolean;
  /** Why the lookup stopped early, when it did. */
  error?: string;
};

/**
 * EFetch every author's affiliations for the PMIDs, for a request handler (the
 * method services save): POST, batches of 200, `NCBI_API_KEY` when set, and
 * one deadline for the whole lookup.
 *
 * Never throws for PubMed's sake. A non-2xx answer, a body that is not a
 * `PubmedArticleSet`, a network error or the deadline stops the lookup, and
 * what was read before that is returned with `complete: false`: the caller
 * keeps it and asks for the rest on a later call, so a list too long for one
 * deadline is finished over several.
 *
 * A PMID missing from a good answer is asked for once more. Only when the
 * second good answer leaves it out too is it taken as one PubMed has no record
 * of (an empty list); a single short answer never reads as "no affiliations".
 */
export async function fetchAuthorAffiliations(
  pmids: ReadonlyArray<string>,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<AuthorAffiliationLookup> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ids = [...new Set(pmids)];
  const affiliations = new Map<string, string[]>();
  if (ids.length === 0) return { affiliations, complete: true };

  const signal = AbortSignal.timeout(opts.timeoutMs ?? AFFILIATION_FETCH_TIMEOUT_MS);
  const apiKey = process.env.NCBI_API_KEY;
  const delay = apiKey ? KEYED_DELAY_MS : DELAY_MS;
  let nextStart = 0;
  /** Wait for this request's turn: starts are `delay` apart across workers. */
  const pace = async () => {
    const now = Date.now();
    const at = Math.max(now, nextStart);
    nextStart = at + delay;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
    signal.throwIfAborted();
  };
  const efetch = async (batch: ReadonlyArray<string>) => {
    await pace();
    const body = new URLSearchParams({ db: "pubmed", retmode: "xml", id: batch.join(",") });
    if (apiKey) body.set("api_key", apiKey);
    const res = await fetchFn(EFETCH, {
      method: "POST",
      body,
      headers: { "User-Agent": "scholars-app/1.0" },
      signal,
    });
    if (!res.ok) throw new Error(`EFetch ${res.status}`);
    return parseEfetchAnswer(await res.text());
  };

  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) batches.push(ids.slice(i, i + ID_BATCH));
  let error: string | undefined;
  const fail = (err: unknown) => {
    error ??= err instanceof Error ? err.message : String(err);
  };
  /** Asked for, and left out of a good answer. */
  const absent: string[] = [];
  let next = 0;
  const worker = async () => {
    while (error === undefined && next < batches.length) {
      const batch = batches[next++];
      try {
        const got = await efetch(batch);
        for (const pmid of batch) {
          const value = got.get(pmid);
          if (value) affiliations.set(pmid, value);
          else absent.push(pmid);
        }
      } catch (err) {
        fail(err);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(AFFILIATION_FETCH_CONCURRENCY, batches.length) }, worker),
  );

  // The second ask. One at a time: there are rarely any.
  for (let i = 0; i < absent.length && error === undefined; i += ID_BATCH) {
    const batch = absent.slice(i, i + ID_BATCH);
    try {
      const got = await efetch(batch);
      for (const pmid of batch) affiliations.set(pmid, got.get(pmid) ?? []);
    } catch (err) {
      fail(err);
    }
  }

  const complete = ids.every((pmid) => affiliations.has(pmid));
  return { affiliations, complete, ...(error === undefined ? {} : { error }) };
}
