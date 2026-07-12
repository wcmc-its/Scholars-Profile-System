// Distinguishes a PubMed publication from a manually-added external-source one
// (ReCiterDB #101). External pubs are keyed on their stable, source-prefixed
// article_id (e.g. "SCOPUS:105037533819"), so a non-numeric pmid means "not from
// PubMed" and the prefix names the source. A real PubMed pmid is all digits.
// Single source of truth for that distinction across the render, so no component
// builds a dead pubmed.ncbi link for a non-PubMed pmid.

const SOURCE_LABELS: Record<string, string> = {
  SCOPUS: "Scopus",
  OPENALEX: "OpenAlex",
  WOS: "Web of Science",
};

export function pubSource(pmid: string | null | undefined): {
  isPubmed: boolean;
  sourceLabel: string | null;
} {
  if (!pmid) return { isPubmed: false, sourceLabel: null };
  if (/^\d+$/.test(pmid)) return { isPubmed: true, sourceLabel: null };
  const prefix = pmid.split(":")[0].toUpperCase();
  return { isPubmed: false, sourceLabel: SOURCE_LABELS[prefix] ?? "External" };
}
