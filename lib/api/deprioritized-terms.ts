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

  const kept: string[] = [];
  const removed: string[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (set.has(normalizeForMatch(token))) removed.push(token);
    else kept.push(token);
  }
  if (kept.length === 0) return { contentQuery: trimmed, removed: [] };
  return { contentQuery: kept.join(" "), removed };
}

/** @internal — test-only hook. Resets the module-level set cache. */
export function _resetDeprioritizedCacheForTests(): void {
  cache = null;
}
