/** SPS `Publication.pmid` key for a ReCiterDB article — mirrors `pubKey` in
 *  etl/reciter/index.ts: external rows key on the stable source-prefixed
 *  article_id (their synthetic negative pmid churns nightly), PubMed rows on
 *  the pmid. The one definition the mentee-suggestion builder and the
 *  mentoring bridge export share. */
export function pubKey(pmid: number, articleId: string | null): string {
  return articleId != null && articleId.length <= 32 ? articleId : String(pmid);
}
