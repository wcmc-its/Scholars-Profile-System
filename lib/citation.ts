/**
 * Shared Vancouver-citation string logic (#2580).
 *
 * Four builders render a citation — the WCM CV (`lib/edit/cv-export.ts`), the
 * search Word bibliography (`lib/api/word-bibliography.ts`), and the two
 * `/scholars/<slug>/co-pubs[/<menteeCwid>]/export` routes — and each carried its
 * OWN copy of the volume/issue/pages formatter plus its own hand-rolled
 * `PMID: <value>` block. Two bugs therefore shipped four times over:
 *
 *   1. The formatter guarded only against JS falsy, so a `Publication.volume`
 *      holding the literal four-character string `"NULL"` (the columns are
 *      `String? @db.VarChar`, and some upstream rows carry the word rather than
 *      a SQL NULL) sailed through truthy and printed
 *      `2024;NULL(NULL):NULL.` in a downloaded document.
 *   2. Every builder labelled `Publication.pmid` `PMID:` unconditionally. That
 *      column is `String @id @db.VarChar(32)` and holds a source-prefixed
 *      article id for non-PubMed records (`SCOPUS:105037533819`, ReCiterDB
 *      #101) — so the CV printed `PMID: SCOPUS:105037533819`, and the .docx
 *      builders additionally wrapped it in a `pubmed.ncbi.nlm.nih.gov/<id>/`
 *      hyperlink that is dead on arrival in the reader's Word document.
 *
 * Only the string/decision logic lives here; each call site keeps its own
 * rendering concern (plain `Run`s, docx `TextRun`s, `ExternalHyperlink`s).
 */
import { pubSource } from "@/lib/publication-source";

/**
 * A citation field that is PRESENT in the database but means "absent".
 *
 * Whitespace-only, and the literal word `NULL` in any casing — the shape a
 * `VARCHAR` column takes when an upstream export wrote the string instead of a
 * SQL NULL. Deliberately narrow: `"N/A"`, `"none"` and `"-"` are NOT swept in,
 * because no evidence says the corpus uses them here and a real volume or page
 * range could plausibly look like one. `"Suppl"`, `"Spec No"`, `"IX"` and
 * `"DECIPHeR"` are all real volume/issue/pages values in this corpus.
 *
 * Exported (rather than kept private to the two builders below) so the ReciterDB
 * ETL can null the same literal at ingest with the SAME predicate — one place
 * decides what "absent" means for these columns (#2580).
 */
export function isAbsentValue(value: string | null | undefined): boolean {
  if (value == null) return true;
  const t = value.trim();
  return t === "" || t.toLowerCase() === "null";
}

/**
 * The NLM volume/issue/pages segment: `Vol(Issue):Pages`, each piece omitted
 * when absent, and `""` when all three are — so the caller renders the year
 * alone (`2024.`) rather than `2024;.`.
 *
 * Values are trimmed, so a padded `" 83 "` does not print as `2024; 83 (4)`.
 */
export function formatVolIssuePages(
  volume: string | null | undefined,
  issue: string | null | undefined,
  pages: string | null | undefined,
): string {
  const v = isAbsentValue(volume) ? "" : volume!.trim();
  const i = isAbsentValue(issue) ? "" : issue!.trim();
  const p = isAbsentValue(pages) ? "" : pages!.trim();
  if (!v && !i && !p) return "";
  let s = v;
  if (i) s += `(${i})`;
  if (p) s += `:${p}`;
  return s;
}

/**
 * How to label and (optionally) link a publication's identifier in a citation.
 *
 * `href` is non-null ONLY for a real PubMed record. External-source ids get no
 * hyperlink on purpose: neither Scopus, OpenAlex nor Web of Science exposes a
 * public, stable, id-addressable landing page we can build a URL for without an
 * API key or an institutional entitlement, and a link that resolves to a login
 * wall inside a downloaded .docx is worse than plain text. The DOI on the same
 * citation line remains the resolvable link for these records.
 */
export type CitationIdentifier = {
  /** `"PMID"`, an external source name (`"Scopus"`), or `"Source"`. */
  label: string;
  /** The bare id (`"105037533819"`), or the source name when there is no id. */
  value: string;
  /** PubMed record URL, or null when the id is not a PubMed id. */
  href: string | null;
};

/**
 * Decide how to render a publication's identifier. Delegates the "is this a
 * PubMed id?" question to {@link pubSource}, the module that already owns that
 * distinction for the profile/modal render, so a new source prefix is taught to
 * the app in exactly one place.
 *
 * Renders as `${label}: ${value}`:
 *   - `39123456`             → `PMID: 39123456` (hyperlinked)
 *   - `SCOPUS:105037533819`  → `Scopus: 105037533819` (plain text)
 *   - `-3`                   → `Source: External` — the synthetic negative pmid
 *     ReCiterDB assigns an external record whose `article_id` exceeded 32 chars.
 *     It is a churn-prone internal key, not a citable id, so it is never shown.
 *
 * Accepts a number because the co-pubs routes carry `CoPublicationFull.pmid` as
 * a number (a negative one for those same external records).
 */
export function citationIdentifier(pmid: string | number): CitationIdentifier {
  const raw = String(pmid);
  const { isPubmed, sourceLabel } = pubSource(raw);
  if (isPubmed) {
    return { label: "PMID", value: raw, href: `https://pubmed.ncbi.nlm.nih.gov/${raw}/` };
  }
  const colon = raw.indexOf(":");
  if (sourceLabel && colon > 0) {
    return { label: sourceLabel, value: raw.slice(colon + 1), href: null };
  }
  return { label: "Source", value: sourceLabel ?? "External", href: null };
}
