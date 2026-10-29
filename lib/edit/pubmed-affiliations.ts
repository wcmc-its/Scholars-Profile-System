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
