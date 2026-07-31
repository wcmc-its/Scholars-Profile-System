/**
 * ADR-011 §Not resolved — the breadth gate. `resolveMeshDescriptor` sometimes
 * hops to a PARENT descriptor because it could not match every word in the
 * query ("functional mri" → `Magnetic Resonance Imaging`, dropping
 * "functional"). The dropped word is the evidence a parent hop happened at
 * all, and it is already in the payload (`matchedForm`) — no tree walk
 * needed. This module computes that signal; it does not consume it. Nothing
 * here reads or writes a ranking score.
 *
 * Deliberately NOT in `lib/api/normalize.ts`: that module backs the resolver's
 * own matching (#259) and generic-term demotion (#692); this is a downstream
 * consumer of the resolver's OUTPUT (`matchedForm`), a different concern with
 * its own threshold to tune. Same tokenization rule as
 * {@link import("./normalize").normalizeForMatch} (lowercase, drop standalone
 * "and", split on non-alphanumerics) so a token here means the same thing it
 * means to the resolver — kept local rather than shared to avoid coupling this
 * classifier's threshold to the resolver's matching internals.
 *
 * ⚠ Offline-validation-only per the ADR: "Run the classifier over the query
 * log, eyeball a few hundred classifications... without touching ranking at
 * all." No caller wires this into `searchPeople` yet.
 */
function contentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\band\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Distinct content-word tokens of `query` that do not appear among
 * `matchedForm`'s tokens. Order follows first appearance in `query`.
 *
 * Token-level, unlike `isFullQueryMeshMatch`'s whole-string equality:
 * `unconsumedContentTokens("functional mri", "MRI")` returns `["functional"]`,
 * not just "not equal" — the ADR's worked examples need to see WHICH word was
 * dropped to judge whether the drop changed what the query meant.
 */
export function unconsumedContentTokens(query: string, matchedForm: string): string[] {
  const matchedSet = new Set(contentTokens(matchedForm));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of contentTokens(query)) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (!matchedSet.has(t)) out.push(t);
  }
  return out;
}

/**
 * Fraction of `query`'s distinct content tokens consumed by `matchedForm`.
 * 1.0 = every token accounted for. An empty (or fully-stripped) query has
 * nothing to fail to consume, so it reads as fully covered rather than 0/0.
 *
 * ADR-011's starting threshold is "gate to the low weight when coverage <
 * 1.0" — the strictest setting, flagging ANY unconsumed word. That threshold
 * is not baked in here on purpose: it is what the offline validation is
 * tuning, not a derived constant.
 */
export function contentWordCoverage(query: string, matchedForm: string): number {
  const distinctQueryTokens = new Set(contentTokens(query));
  if (distinctQueryTokens.size === 0) return 1;
  const unconsumed = unconsumedContentTokens(query, matchedForm);
  return (distinctQueryTokens.size - unconsumed.length) / distinctQueryTokens.size;
}
