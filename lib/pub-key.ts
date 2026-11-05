import { createHash } from "node:crypto";

/** SPS `Publication.pmid` is VarChar(32). PM #1060: a `CROSSREF:<doi>` article_id is
 *  often longer, so it keys on `CROSSREF:` + 23 hex chars of the id's sha1 (stable,
 *  still labelled Crossref; the DOI itself lives in `Publication.doi`). Any other
 *  external id over 32 chars has no stable key, so the caller keeps the synthetic pmid. */
export function externalKey(articleId: string): string | null {
  if (articleId.length <= 32) return articleId;
  if (articleId.startsWith("CROSSREF:")) {
    return "CROSSREF:" + createHash("sha1").update(articleId, "utf8").digest("hex").slice(0, 23);
  }
  return null;
}

/** SPS `Publication.pmid` key for a ReCiterDB article — mirrors `pubKey` in
 *  etl/reciter/index.ts: external rows key on the stable source-prefixed
 *  article_id (their synthetic negative pmid churns nightly), PubMed rows on
 *  the pmid. The one definition the mentee-suggestion builder and the
 *  mentoring bridge export share. */
export function pubKey(pmid: number, articleId: string | null): string {
  return (articleId != null && externalKey(articleId)) || String(pmid);
}
