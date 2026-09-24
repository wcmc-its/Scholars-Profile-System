/**
 * Issue #692 — generic/filler-term demotion for search query interpretation.
 *
 * A trailing/embedded generic word ("Microbiome **Research**") silently breaks
 * MeSH resolution (the whole string normalizes to `microbiomeresearch`, which is
 * no descriptor's form) and, in the BM25 fallback, matches + `<mark>`-highlights
 * as a full-weight token. This module supplies the curated set and a tokenizer
 * that strips those terms so callers can (a) retry resolution on the surviving
 * "content" query and (b) score/highlight on content only.
 *
 * Depends only on `@/lib/api/normalize` (no Prisma graph) so it matches the
 * resolver's normalization exactly while staying cheap to unit-test.
 */
import groups from "@/data/search/deprioritized-terms.json";
import { normalizeForMatch } from "@/lib/api/normalize";

/** The group held OUT of the default set — subdomain-dependent terms
 *  (system/systems/model/models) that are generic in some contexts but
 *  load-bearing in others ("systems biology", "animal model"). Loaded
 *  separately so a future revision can opt them into a weaker tier. */
const CAUTION_GROUP = "_caution_subdomain_dependent";

let cache: { default: Set<string>; caution: Set<string> } | null = null;

/**
 * Build (once) the normalized deprioritized sets from the committed JSON.
 * `default` = every group except the caution group; `caution` = that group.
 * Keys are `normalizeForMatch(term)` so lookups match the resolver's forms.
 */
export function loadDeprioritizedSet(): {
  default: Set<string>;
  caution: Set<string>;
} {
  if (cache) return cache;
  const def = new Set<string>();
  const caution = new Set<string>();
  for (const [group, terms] of Object.entries(
    groups as Record<string, string[]>,
  )) {
    const target = group === CAUTION_GROUP ? caution : def;
    for (const term of terms) {
      const n = normalizeForMatch(term);
      if (n.length > 0) target.add(n);
    }
  }
  cache = { default: def, caution };
  return cache;
}

/**
 * Split a query into a generic-free "content" query plus the removed surface
 * tokens. A whitespace token is removed iff its normalized form is in the
 * default set.
 *
 * NEVER-EMPTY CONTRACT: if every token is deprioritized (e.g. "clinical
 * trial"), returns the original trimmed query with `removed: []`, so the caller
 * treats it as "no strip" and behavior is unchanged. Only the default set is
 * applied; the caution group is never stripped.
 */
export function stripDeprioritized(query: string): {
  contentQuery: string;
  removed: string[];
} {
  const { default: set } = loadDeprioritizedSet();
  const trimmed = query.trim();
  if (trimmed.length === 0) return { contentQuery: "", removed: [] };

  const tokens = trimmed.split(/\s+/);
  const isRemoved = tokens.map((t) => set.has(normalizeForMatch(t)));
  const removed = tokens.filter((_, i) => isRemoved[i]);
  if (removed.length === 0) return { contentQuery: trimmed, removed: [] };

  // A connector run ("in", "&", "of the") survives only when it still sits between
  // two KEPT content words, exactly as typed. One left dangling at an edge, or made
  // to touch a removed token, is dropped: "Climate change & health" → "Climate", not
  // "Climate &"; "Large language models in medicine" → "Large language models".
  // Connectors are not reported in `removed` (that list is the filler actually
  // demoted, and feeds the #1980 kept-enough ratio).
  const isConnector = tokens.map((t) => CONNECTORS.has(t.toLowerCase()));
  const isContent = (i: number) =>
    i >= 0 && i < tokens.length && !isRemoved[i] && !isConnector[i];
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (isRemoved[i]) continue;
    if (!isConnector[i]) {
      kept.push(tokens[i]);
      continue;
    }
    let start = i;
    while (start > 0 && isConnector[start - 1] && !isRemoved[start - 1]) start--;
    let end = i;
    while (end < tokens.length - 1 && isConnector[end + 1] && !isRemoved[end + 1]) end++;
    if (isContent(start - 1) && isContent(end + 1)) kept.push(tokens[i]);
  }
  // Only filler + connectors → NEVER-EMPTY contract: leave the query intact.
  if (kept.length === 0) {
    return { contentQuery: trimmed, removed: [] };
  }
  return { contentQuery: kept.join(" "), removed };
}

/** Function words / joiners that carry no meaning once a neighbor is stripped. */
const CONNECTORS: ReadonlySet<string> = new Set([
  "in", "of", "for", "and", "or", "the", "a", "an", "with", "on", "to", "&", "+", "/",
]);

/**
 * #692 follow-up — the content query a SEARCH should score/highlight on, given how
 * the FULL typed query resolved in MeSH. When the whole phrase resolved verbatim
 * (`exact` / `entry-term` — "Climate change", "Gene editing", "Value-based care"),
 * the phrase itself is the concept, so it is kept as typed: stripping its filler
 * word left the literal mention arm matching a fragment ("Climate", "editing").
 * Any other outcome (no resolution, `partial`, or a verbatim hit that only the
 * stripped retry found) strips as before, so "Microbiome Research" still demotes.
 *
 * `fullQueryMeshConfidence` must be the resolution of the UNSTRIPPED query — not the
 * final, possibly retry-adopted one (see `resolveQueryTaxonomy`).
 */
export function stripDeprioritizedUnlessResolved(
  query: string,
  fullQueryMeshConfidence: string | null | undefined,
): { contentQuery: string; removed: string[] } {
  if (fullQueryMeshConfidence === "exact" || fullQueryMeshConfidence === "entry-term") {
    return { contentQuery: query.trim(), removed: [] };
  }
  return stripDeprioritized(query);
}

/**
 * #1972 — is every token of `text` a deprioritized filler term?
 *
 * Used to judge whether a `partial` MeSH resolution is worth protecting from the #692
 * §4.1 strip retry. The window fallback stamps `partial` on the longest contiguous window
 * of the query that resolved, and its size-1 arm requires an exact descriptor NAME
 * (search-taxonomy.ts:1582) — so for `cancer research` the lay token `cancer` (an entry
 * term) is skipped and the FILLER token `research` wins, giving `Research`/partial. That
 * window carries none of the query's meaning and must not block the retry that recovers
 * `Neoplasms`. A window holding real content (`stem cells`, `kidney disease`) must.
 *
 * NOTE this cannot be derived from `stripDeprioritized().removed`: the never-strip-to-empty
 * rule above returns `removed: []` for an all-filler string, identically to an all-content
 * one.
 *
 * ⚠ `matchedForm` has TWO provenances. The window fallback sets it to the matched QUERY
 * WINDOW (search-taxonomy.ts:1596) — user tokens, which is what this predicate is really
 * about. The #1342 singularize retry sets it to the matched DESCRIPTOR form
 * (search-taxonomy.ts:1386-1391), so for that provenance this reads a descriptor surface
 * form instead. It degrades the right way (a descriptor whose own name is nothing but
 * filler is a weak interpretation too), but it is not the same question, so don't extend
 * this predicate to new callers without re-checking which provenance they see.
 */
export function isAllDeprioritized(text: string): boolean {
  const { default: set } = loadDeprioritizedSet();
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((token) => set.has(normalizeForMatch(token)));
}

/** @internal — test-only hook. Resets the module-level set cache. */
export function _resetDeprioritizedCacheForTests(): void {
  cache = null;
}
