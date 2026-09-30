/**
 * Product references inside the biosketch narrative (#2653 v8, Phase 2 spec F3).
 *
 * NIH's Common Form supplement allows SHORT parenthetical references in the Personal Statement
 * and the Contributions to Science, but only to the ten listed products, by lead author and
 * year (or PMID); full citations and hyperlinks are non-compliant. Nothing enforced that before
 * v8. The contract here:
 *
 *   1. The payload hands the model the products with a short KEY each (`[P1]`..`[P10]`, list
 *      order: related first, then other significant). The model references a product ONLY by
 *      its key, in square brackets, right after the claim it supports.
 *   2. After parse, {@link validateProductReferences} renders every in-list key to the NIH
 *      lead-author-and-year form (`(Smith 2019)`; `(PMID 123)` when no lead author is known),
 *      STRIPS an out-of-list key, an out-of-list PMID parenthetical, and any URL / DOI, and
 *      FLAGS without touching the prose (a) an author-year parenthetical that names no listed
 *      product and (b) a full-citation tell. Author-year is flag-only because the shape is
 *      indistinguishable from ordinary prose ("(March 2020)", "(Phase 2019)"); stripping it
 *      silently mangled grounded text.
 *   3. The faithfulness pass (`buildGroundingReference` / `overviewVerifySystemPrompt`) gets the
 *      rendered list so a reference is never flagged as an ungrounded name/year, and so the
 *      claim it sits on is checked against THAT product's record.
 *
 * PURE and client-safe: no model call, no DB. The regression harness reuses the scanner to
 * count v7's raw reference violations on the same footing as v8's.
 */
import type { BiosketchProducts } from "@/lib/edit/biosketch-products";

/** One referenceable product: its prompt key, the rendered NIH form, and the record. */
export type BiosketchProductRef = {
  /** The short key the model writes, e.g. "P3". */
  key: string;
  pmid: string;
  /** The rendered reference body, e.g. "Smith 2019" or "PMID 12345678". */
  label: string;
  title: string;
  year: number | null;
};

export type BiosketchReferenceIssueKind = "out_of_list" | "url" | "full_citation";

export type BiosketchReferenceIssue = {
  /** The verbatim span found in the draft. */
  span: string;
  kind: BiosketchReferenceIssueKind;
  /** Stripped from the prose, or left in place and only reported. */
  action: "stripped" | "flagged";
};

export type BiosketchReferenceReport = {
  /** In-list references rendered into the text. */
  kept: number;
  issues: BiosketchReferenceIssue[];
};

/**
 * The lead author's surname from a `Publication.authorsString` ("Smith AB, ((Jones C)), Lee D":
 * comma-separated "Surname Initials" tokens, the WCM author wrapped in the `((…))` hyperlink
 * marker, which is MARKUP not data). Drops a trailing initials token so "van der Berg AB"
 * yields "van der Berg". `null` when there is nothing usable.
 */
export function leadAuthorSurname(authorsString: string | null | undefined): string | null {
  if (!authorsString) return null;
  const first = authorsString
    .split(",")[0]
    ?.trim()
    .replace(/^\(\((.*)\)\)$/, "$1")
    .trim();
  if (!first) return null;
  const parts = first.split(/\s+/);
  if (parts.length > 1 && /^[A-Z][A-Z-]{0,3}\.?$/.test(parts[parts.length - 1]!)) parts.pop();
  const surname = parts.join(" ").trim();
  return surname.length > 0 ? surname : null;
}

/**
 * Key the products for the prompt: related first, then other significant, `P1`.. in list
 * order, one key per distinct pmid. The label is the NIH lead-author-and-year form when both
 * are known, else the PMID form (NIH accepts either).
 */
export function productReferenceList(
  products: BiosketchProducts,
  pubs: readonly { pmid: string; leadAuthor?: string | null }[],
): BiosketchProductRef[] {
  const leadByPmid = new Map(pubs.map((p) => [p.pmid, p.leadAuthor ?? null]));
  const seen = new Set<string>();
  const refs: BiosketchProductRef[] = [];
  for (const p of [...products.related, ...products.otherSignificant]) {
    if (seen.has(p.pmid)) continue;
    seen.add(p.pmid);
    const lead = leadByPmid.get(p.pmid) ?? null;
    refs.push({
      key: `P${refs.length + 1}`,
      pmid: p.pmid,
      label: lead && p.year ? `${lead} ${p.year}` : `PMID ${p.pmid}`,
      title: p.title,
      year: p.year,
    });
  }
  return refs;
}

/** The user-turn block listing the referenceable products by key (empty string when none). */
export function buildProductReferencePrompt(refs: readonly BiosketchProductRef[]): string {
  if (refs.length === 0) return "";
  return [
    "PRODUCTS you may reference (by KEY only, in square brackets after the claim it supports;",
    "each is rendered as the parenthetical shown — never write that form, a name, a year, a",
    "PMID, or a URL yourself):",
    ...refs.map(
      (r) => `- [${r.key}] renders as (${r.label}): ${r.title}${r.year ? ` (${r.year})` : ""}`,
    ),
  ].join("\n");
}

// A square-bracket group of one or more keys: "[P3]", "[P2, P5]". Brackets only, so a gene or
// phase parenthetical like "(P53)" is never mistaken for a key.
const KEY_GROUP_RE = /\[\s*P\d{1,2}(?:\s*[,;]\s*P\d{1,2})*\s*\]/g;
// An author-year parenthetical the model wrote itself: "(Smith 2019)", "(Smith et al., 2019)".
// Also matches plain prose ("(March 2020)"), so an out-of-list hit is FLAGGED, never stripped.
const AUTHOR_YEAR_RE = /\(\s*([A-Z][\p{L}'-]+)(?:\s+et\s+al\.?)?,?\s+((?:19|20)\d{2})\s*\)/gu;
// A PMID / PMCID parenthetical: "(PMID 123)", "(PMID: 123)", "(PMCID: PMC123)".
const PMID_RE = /\(\s*PM(?:C)?ID:?\s*(?:PMC)?(\d+)\s*\)/gi;
// Hyperlinks and DOIs, non-compliant in the Common Form prose. The last character may not be
// sentence punctuation, so "see https://x.org/y." keeps its full stop.
export const URL_RE = /(?:https?:\/\/|\bwww\.|\bdoi\.org\/|\bdoi:\s*10\.)[^\s)\]]*[^\s)\].,;:]/gi;
// ponytail: full-citation detection is two journal-citation tells (year;volume, vol(issue):pages)
// — enough to flag a pasted reference, not a citation parser. Flag-only, never stripped.
const FULL_CITATION_RE =
  /\b(?:19|20)\d{2}\s*;\s*\d+\b|\b\d+\s*\(\d+\)\s*:\s*\d+(?:\s*[-–]\s*\d+)?\b/g;

/** Scan without mutating: every reference-shaped span and what the validator would do with it. */
export function scanReferenceIssues(
  text: string,
  refs: readonly BiosketchProductRef[],
): BiosketchReferenceIssue[] {
  const byKey = new Map(refs.map((r) => [r.key, r]));
  const byLabel = new Map(refs.map((r) => [r.label.toLowerCase(), r]));
  const byPmid = new Map(refs.map((r) => [r.pmid, r]));
  const issues: BiosketchReferenceIssue[] = [];
  for (const m of text.matchAll(KEY_GROUP_RE)) {
    const keys = m[0]
      .slice(1, -1)
      .split(/[,;]/)
      .map((k) => k.trim());
    if (!keys.every((k) => byKey.has(k)))
      issues.push({ span: m[0], kind: "out_of_list", action: "stripped" });
  }
  for (const m of text.matchAll(AUTHOR_YEAR_RE)) {
    if (!byLabel.has(`${m[1]} ${m[2]}`.toLowerCase())) {
      issues.push({ span: m[0], kind: "out_of_list", action: "flagged" });
    }
  }
  for (const m of text.matchAll(PMID_RE)) {
    if (!byPmid.has(m[1]!)) issues.push({ span: m[0], kind: "out_of_list", action: "stripped" });
  }
  for (const m of text.matchAll(URL_RE))
    issues.push({ span: m[0], kind: "url", action: "stripped" });
  for (const m of text.matchAll(FULL_CITATION_RE)) {
    issues.push({ span: m[0], kind: "full_citation", action: "flagged" });
  }
  return issues;
}

/** Drop every key group from a string without rendering it (a TITLE line never carries a
 *  reference). */
export function stripProductKeys(text: string): string {
  return text
    .replace(KEY_GROUP_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Tidy the whitespace and punctuation a stripped span leaves behind. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Render in-list references and remove the unambiguous out-of-list ones. The `[P3]` key form
 * becomes `(Smith 2019)`; a group with some out-of-list keys keeps its in-list members; an
 * author-year parenthetical the model wrote itself is normalized to the product's label when it
 * names a listed product and otherwise left in place and reported (it may be prose); a PMID
 * parenthetical is kept ONLY when it names a listed product. URLs / DOIs are removed. A
 * full-citation tell is reported, not edited. Never throws; empty `refs` still strips URLs and
 * stray keys.
 */
export function validateProductReferences(
  text: string,
  refs: readonly BiosketchProductRef[],
): { text: string; report: BiosketchReferenceReport } {
  const byKey = new Map(refs.map((r) => [r.key, r]));
  const byLabel = new Map(refs.map((r) => [r.label.toLowerCase(), r]));
  const byPmid = new Map(refs.map((r) => [r.pmid, r]));
  const issues = scanReferenceIssues(text, refs);
  let kept = 0;

  // The model's own parentheticals first, the keys LAST: a key renders to the same "(Smith 2019)"
  // form the author-year pass matches, and rendering it first would count it twice.
  let out = text.replace(AUTHOR_YEAR_RE, (whole, surname: string, year: string) => {
    const ref = byLabel.get(`${surname} ${year}`.toLowerCase());
    if (!ref) return whole;
    kept += 1;
    return `(${ref.label})`;
  });
  out = out.replace(PMID_RE, (whole, pmid: string) => {
    const ref = byPmid.get(pmid);
    if (!ref) return "";
    kept += 1;
    return `(${ref.label})`;
  });
  out = out.replace(KEY_GROUP_RE, (group) => {
    const labels = group
      .slice(1, -1)
      .split(/[,;]/)
      .map((k) => byKey.get(k.trim())?.label)
      .filter((l): l is string => l !== undefined);
    kept += labels.length;
    return labels.length > 0 ? `(${labels.join("; ")})` : "";
  });
  out = out.replace(URL_RE, "");

  return { text: tidy(out), report: { kept, issues } };
}
