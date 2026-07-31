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

/**
 * Same as {@link unconsumedContentTokens}, but consumed against the UNION of
 * every `forms` string, not just the single winning `matchedForm`.
 *
 * Measured (offline validation, #2097, 313-query census): a MeSH descriptor's
 * winning `matchedForm` is one entry term among several, and a real synonym of
 * the query can sit in a DIFFERENT entry term on the same descriptor —
 * `antimicrobial resistance` doesn't lexically overlap `Drug Resistance,
 * Microbial` (the winning form) at all, but the same descriptor's entry-term
 * list includes `Antimicrobial Drug Resistance`. Widening to the full list
 * redeemed 18 of 72 real flagged queries, mostly acronyms (`ALS`, `MRI`) and
 * near-synonyms. It does NOT fix the qualifier-drop confusion below — pass
 * `[resolution.matchedForm, resolution.name, ...resolution.entryTerms]`.
 */
export function unconsumedAgainstForms(query: string, forms: readonly string[]): string[] {
  const matchedSet = new Set(forms.flatMap(contentTokens));
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
 * ADR-011's "MeSH qualifier axis" — the fallback the offline validation
 * (#2097) found necessary. A raw coverage ratio (even entry-term-widened)
 * cannot tell a QUALIFIER DROP (`Cardiac amyloidosis` → `Amyloidosis`, right
 * concept, under-specific) from a SCOPE-SHIFT (`AAV gene therapy` →
 * `Dependovirus`, wrong concept — the therapy dropped, only the virus
 * remains): both leave a content word on the floor. Measured: 15 of 17 real
 * qualifier-drop cases still failed a widened coverage check.
 *
 * The distinguishing test that IS computable without a tree walk: does the
 * DROPPED SPAN, resolved on its OWN, name a genuinely different MeSH
 * concept? `"lung cancer"` (dropped from `EGFR-mutant lung cancer`) resolves
 * to `Lung Neoplasms` — a real, distinct descriptor, so its loss changed what
 * was asked. `"cardiac"` (dropped from `Cardiac amyloidosis`) does not
 * independently resolve to anything — it is a bare modifier, not a concept —
 * so its loss is a specificity cost, not a concept change.
 *
 * `resolveDescriptor` is injected (not imported) so this stays testable
 * without a DB: the real caller passes `resolveMeshDescriptor` from
 * `@/lib/api/search-taxonomy`; a fixture in tests passes a fake.
 */
export type BreadthGateVerdict = "consumed" | "qualifier-drop" | "scope-shift";

/**
 * Decreasing-length contiguous windows of `tokens`, longest first, down to
 * pairs (length ≥ 2). Single-word windows are excluded on purpose: measured
 * (#2097 validation v1), resolving a lone generic word like "lung" or
 * "inhibitors" either misses or hits an unrelated descriptor at high enough
 * a rate that it made scope-shift detection WORSE, not better — a bare
 * content word carries too little of the original phrase's meaning to trust
 * on its own. A 2+-word window is closer to how the resolver itself matches.
 */
function decreasingWindows(tokens: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let len = tokens.length; len >= 2; len--) {
    for (let start = 0; start + len <= tokens.length; start++) {
      out.push(tokens.slice(start, start + len));
    }
  }
  return out;
}

/**
 * ADR-011's "MeSH qualifier axis" heuristic (#2097). Joining every unconsumed
 * token into one span and resolving it, v1, caught only 2 of 9 real
 * scope-shifts — dropped modifier words like "mutant" and "osimertinib"
 * diluted phrases like "lung cancer" enough that the combined span resolved
 * to nothing. v2 tries decreasing-length windows of the unconsumed tokens (in
 * their original query order) and takes the LONGEST one that independently
 * resolves to a descriptor DIFFERENT from the query's own — the longest
 * window is the strongest evidence a real, distinct concept was dropped.
 *
 * Measured against the same 313-query census, staging, live resolver (#2097):
 * catches **5 of 9 (56%)** real scope-shifts, up from 2 of 9. Precision on the
 * three classes that must NOT be flagged rose to **90%** (63 of 70: 15/17
 * qualifier-drop, 24/25 synonym, 19/19 acronym) from 82%. Not perfect — the 4
 * remaining misses are a genuine hardness class: `healthspan` is a single
 * dropped token (excluded by design, see {@link decreasingWindows}), and
 * `KRAS inhibitors` / `CDK4/6 inhibitors` drop a drug-class word
 * ("inhibitors") too generic to resolve to any specific descriptor on its
 * own. Closing that gap needs real MeSH qualifier/subheading data, not more
 * window permutations — out of scope here.
 */
export async function classifyBreadthGate(
  query: string,
  resolution: { descriptorUi: string; matchedForm: string; name: string; entryTerms: readonly string[] },
  resolveDescriptor: (q: string) => Promise<{ descriptorUi: string } | null>,
): Promise<BreadthGateVerdict> {
  const forms = [resolution.matchedForm, resolution.name, ...resolution.entryTerms];
  const unconsumed = unconsumedAgainstForms(query, forms);
  if (unconsumed.length === 0) return "consumed";
  for (const window of decreasingWindows(unconsumed)) {
    const spanResolution = await resolveDescriptor(window.join(" "));
    if (spanResolution && spanResolution.descriptorUi !== resolution.descriptorUi) {
      return "scope-shift";
    }
  }
  return "qualifier-drop";
}

/**
 * ADR-011: "The gate must select a weight, not kill the boost." A qualifier
 * drop keeps today's high weight (the concept is right, just under-specific —
 * no reason to suppress it); a scope-shift drops to the low weight (the
 * resolver hopped to the wrong concept, so the boost should not lean on it).
 */
export function breadthGateWeight(
  verdict: BreadthGateVerdict,
  { wHi, wLo }: { wHi: number; wLo: number },
): number {
  return verdict === "scope-shift" ? wLo : wHi;
}
