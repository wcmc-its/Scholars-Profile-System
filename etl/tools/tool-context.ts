/**
 * Pure helpers for the ReciterAI tool-context artifact (#1119) — the
 * `tool_id → { pmid → usage-sentence }` map published at
 * s3://wcmc-reciterai-artifacts/tools/latest/tool_context.json
 * (`tool_context_kind: "tool_usage_snippet"`). Side-effect-free + unit-tested,
 * so the junk filter and best-snippet selection are verifiable without an S3
 * fetch or a DB — exactly like the sibling tool/family mappers.
 *
 * The snippets are EXTRACTED real text from the publication (not a generated
 * gloss like the #879 family definition), so they are legitimate grounding for
 * the overview generator. Like any artifact text, they remain strictly
 * injection-safe DATA in any LLM prompt — callers never interpolate them as
 * instructions.
 *
 * Best-of-N rule (#1119, chosen against the live artifact: per-tool survivor
 * count is p50=1 / p90=2, so N rarely bites; it only matters for generic
 * high-frequency tools the Methods lens already deprioritizes):
 *   1. Candidate set = the tool's junk-filter survivors, intersected with the
 *      caller's pmid scope when one is supplied and non-empty; fall back to ALL
 *      survivors if the intersection is empty.
 *   2. Bias to snippets that NAME the tool (contain a salient form of its display
 *      name) so the chosen snippet is *about* the tool, not an incidental mention.
 *   3. Among the preferred bucket, pick the LONGEST (most descriptive), clamped
 *      to MAX_SNIPPET_LEN. Keep the source pmid for provenance. Deterministic
 *      (length desc, then pmid asc).
 */

/** Snippets shorter than this are observed boilerplate, not descriptions. */
export const MIN_SNIPPET_LEN = 25;
/** Hard cap on a stored snippet — long enough to describe a tool, short enough
 *  to avoid the runaway paper-specific prose seen on generic high-N tools. */
export const MAX_SNIPPET_LEN = 240;

/**
 * #1119 opaque-tool gate. A tool used in MORE than this many papers (its GLOBAL
 * canonical `pub_count`) is a common, self-explanatory method whose usage snippet
 * is one paper's specific result, not a definition — measured display win-rate is
 * ~2% at `pub_count ≥ 5` vs ~28–34% below the cut, with 96% of real wins retained
 * (see `docs/methodcontext-snippet-eval-findings.md` §3). `selectBestSnippet`
 * suppresses the snippet for such a tool, but ONLY when a numeric `pub_count` is
 * supplied — an unknown count never gates (conservative: keep the snippet).
 */
export const MAX_PUB_COUNT_FOR_SNIPPET = 4;

/** The leading fraction of a snippet within which a "subject" mention of the tool
 *  must appear. Real wins name the tool early (median position ~0.28); foils name
 *  it late as a contrast/incidental mention (~0.81). Used as a selection PREFERENCE
 *  in the name-bias pass — never a hard drop (see findings §5). */
export const EARLY_NAME_MAX_FRACTION = 0.75;

/**
 * Junk filter (#1119): drop bare URLs, "available at …" repo pointers, raw
 * code-host links, and sub-`MIN_SNIPPET_LEN` boilerplate. Observed on the live
 * artifact, e.g. `Blackbird → "available at https://github.com/1dayac/Blackbird"`.
 * Pure predicate over a single raw snippet (whitespace-insensitive).
 */
export function isUsableSnippet(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (s.length < MIN_SNIPPET_LEN) return false;
  if (/^https?:\/\//i.test(s)) return false;
  if (/^available\s+(online\s+)?at\b/i.test(s)) return false;
  // A short snippet dominated by a code-host link is a pointer, not a description.
  if (/(?:github|gitlab|bitbucket)\.(?:com|org)/i.test(s) && s.length < 80) return false;
  return true;
}

/** Collapse internal whitespace and clamp to MAX_SNIPPET_LEN at a word boundary. */
export function clampSnippet(raw: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_SNIPPET_LEN) return t;
  const cut = t.slice(0, MAX_SNIPPET_LEN);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > MAX_SNIPPET_LEN * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * Salient lowercase forms of a tool display name, used by the name-bias pass:
 * the full name, any parenthetical short form (e.g. "(MRI)" → "mri",
 * "(scRNA-seq)"), and the name with parentheticals stripped. A snippet "names
 * the tool" when it contains any of these as a case-insensitive substring.
 */
export function salientNameForms(displayName: string): string[] {
  const name = displayName.trim();
  if (!name) return [];
  const forms = new Set<string>();
  const lower = name.toLowerCase();
  if (lower.length >= 3) forms.add(lower);
  for (const m of name.matchAll(/\(([^)]{2,})\)/g)) {
    const inner = m[1].trim().toLowerCase();
    if (inner.length >= 2) forms.add(inner);
  }
  const noParens = lower
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (noParens.length >= 3 && noParens !== lower) forms.add(noParens);
  return [...forms];
}

function namesTool(snippet: string, forms: string[]): boolean {
  if (forms.length === 0) return false;
  const s = snippet.toLowerCase();
  return forms.some((f) => s.includes(f));
}

/** Earliest position (as a fraction of length) at which the snippet names the
 *  tool; returns 1 when it never does. Lower ⇒ the tool is the subject (a win);
 *  high ⇒ a late foil/incidental mention. */
function nameFirstFraction(snippet: string, forms: string[]): number {
  if (forms.length === 0) return 1;
  const s = snippet.toLowerCase();
  let first = -1;
  for (const f of forms) {
    const i = s.indexOf(f);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  return first < 0 ? 1 : first / Math.max(1, snippet.length);
}

/** Continuation words that mark a snippet beginning mid-clause even when the
 *  first letter happens to be capitalized. */
const FRAGMENT_LEAD_RE =
  /^(?:were|was|are|is|been|being|and|but|or|nor|which|that|who|whose|whom|revealing|showing|measuring|comparing|including|yielding|demonstrating|suggesting|indicating|resulting)\b/i;

/**
 * True when the snippet reads as a complete sentence start (begins with a capital
 * letter, digit, or opening bracket and not a dangling continuation word) rather
 * than mid-clause. Used ONLY as a best-of-N TIE-BREAKER — never to drop a snippet:
 * the cheap heuristic is ~45% precise and a hard drop would kill ~half of the real
 * wins, which legitimately begin mid-clause (see findings §4).
 */
export function startsAtSentenceBoundary(snippet: string): boolean {
  const t = snippet.trimStart();
  if (!t) return false;
  if (/^[a-z]/.test(t)) return false;
  if (FRAGMENT_LEAD_RE.test(t)) return false;
  return true;
}

/**
 * Selection comparator: LONGEST (most descriptive) is primary — this preserves
 * real wins that begin mid-clause, so the clean-start signal can only break an
 * exact length tie; the source pmid (asc) is the final deterministic tiebreak.
 */
function isBetterSnippet(c: SurvivingSnippet, best: SurvivingSnippet): boolean {
  if (c.snippet.length !== best.snippet.length) return c.snippet.length > best.snippet.length;
  const cClean = startsAtSentenceBoundary(c.snippet);
  const bClean = startsAtSentenceBoundary(best.snippet);
  if (cClean !== bClean) return cClean;
  return c.pmid < best.pmid;
}

/** A junk-filter-surviving snippet and its provenance pmid, in artifact order. */
type SurvivingSnippet = { pmid: string; snippet: string };

/** Coverage stats for the loader's `--dry-run` report. */
export type ToolContextStats = {
  /** Distinct tool ids present in the artifact's `tool_context`. */
  toolsWithContext: number;
  /** Tool ids with ≥1 junk-filter-surviving snippet. */
  toolsWithUsable: number;
  /** Total raw (pmid, snippet) pairs across all tools. */
  rawSnippets: number;
  /** Pairs dropped by the junk filter. */
  droppedJunk: number;
};

/** Indexed, junk-filtered tool-context, ready for best-snippet selection. */
export type ToolContextIndex = {
  /** tool_id → its surviving snippets, preserving artifact (insertion) order. */
  byTool: Map<string, SurvivingSnippet[]>;
  stats: ToolContextStats;
};

/**
 * Build a junk-filtered index from the parsed `tool_context.json`. Accepts the
 * raw `tool_context` object (`{ tool_id: { pmid: snippet } }`); tolerates a
 * missing/!object value by returning an empty index (a pre-v3 artifact has no
 * tool_context, which is benign — the mappers then leave context null/empty).
 */
export function buildToolContextIndex(rawToolContext: unknown): ToolContextIndex {
  const byTool = new Map<string, SurvivingSnippet[]>();
  const stats: ToolContextStats = {
    toolsWithContext: 0,
    toolsWithUsable: 0,
    rawSnippets: 0,
    droppedJunk: 0,
  };
  if (!rawToolContext || typeof rawToolContext !== "object") return { byTool, stats };

  for (const [toolId, pmidMap] of Object.entries(rawToolContext as Record<string, unknown>)) {
    if (!toolId || !pmidMap || typeof pmidMap !== "object") continue;
    stats.toolsWithContext += 1;
    const survivors: SurvivingSnippet[] = [];
    for (const [pmid, snippet] of Object.entries(pmidMap as Record<string, unknown>)) {
      stats.rawSnippets += 1;
      if (isUsableSnippet(snippet)) {
        survivors.push({ pmid: String(pmid), snippet: snippet.trim() });
      } else {
        stats.droppedJunk += 1;
      }
    }
    if (survivors.length > 0) {
      stats.toolsWithUsable += 1;
      byTool.set(toolId, survivors);
    }
  }
  return { byTool, stats };
}

/** The chosen representative snippet for a tool (clamped) + its provenance pmid. */
export type BestSnippet = { context: string; pmid: string };

/**
 * Choose ONE representative snippet for a tool (the #1119 best-of-N rule above).
 * Returns null when the tool has no usable snippet. `scholarPmids`, when supplied
 * and non-empty, restricts candidates to snippets from those papers (the family
 * path passes the family's member pmids); an empty intersection falls back to all
 * the tool's snippets. `displayName` drives the name-bias pass.
 *
 * #1119 ADR-005 — `excludePmid`, when supplied, drops candidate snippets whose
 * SOURCE pmid is suppressed (whole-publication takedown or per-author hide for the
 * scholar at hand). It is applied to the survivor set FIRST, so neither the
 * scholar-pmid scope NOR the empty-intersection fallback can resurface a suppressed
 * paper's sentence; if every survivor is excluded, the tool gets no snippet (null).
 */
export function selectBestSnippet(
  index: ToolContextIndex,
  toolId: string,
  opts?: {
    displayName?: string | null;
    scholarPmids?: ReadonlySet<string>;
    /** #1119 — the tool's GLOBAL canonical `pub_count`. When numeric and above
     *  `MAX_PUB_COUNT_FOR_SNIPPET`, the snippet is suppressed (opaque-tool gate).
     *  Unknown/non-numeric ⇒ no gate. */
    toolPubCount?: number | null;
    /** #1119 ADR-005 — returns true for a source pmid whose snippet must NOT be
     *  surfaced (suppressed publication). Applied before scope + fallback. */
    excludePmid?: (pmid: string) => boolean;
  },
): BestSnippet | null {
  // #1119 opaque-tool gate — a common, self-explanatory method's snippet is noise
  // (~2% win-rate); suppress it. Only fires when a numeric pub_count is supplied.
  const pubCount = opts?.toolPubCount;
  if (typeof pubCount === "number" && pubCount > MAX_PUB_COUNT_FOR_SNIPPET) return null;

  const all = index.byTool.get(toolId);
  if (!all || all.length === 0) return null;

  // #1119 ADR-005 — drop suppressed source pmids up front (covers scope + fallback).
  const survivors = opts?.excludePmid ? all.filter((c) => !opts.excludePmid!(c.pmid)) : all;
  if (survivors.length === 0) return null;

  let candidates = survivors;
  const scope = opts?.scholarPmids;
  if (scope && scope.size > 0) {
    const inScope = survivors.filter((c) => scope.has(c.pmid));
    if (inScope.length > 0) candidates = inScope; // else keep the full fallback set
  }

  const forms = opts?.displayName ? salientNameForms(opts.displayName) : [];
  let pool = candidates;
  if (forms.length > 0) {
    const named = candidates.filter((c) => namesTool(c.snippet, forms));
    if (named.length > 0) {
      pool = named;
      // Subject-not-foil guard: prefer snippets that name the tool EARLY, not only
      // as a late-sentence foil/contrast. Bucket-prefer; fall back to the late ones
      // when none qualify, so a tool's only snippet is never dropped.
      const early = named.filter(
        (c) => nameFirstFraction(c.snippet, forms) <= EARLY_NAME_MAX_FRACTION,
      );
      if (early.length > 0) pool = early;
    }
  }

  // Longest (by RAW length, before clamping); clean sentence-start breaks an exact
  // length tie; pmid asc is the final deterministic tiebreak.
  let best = pool[0];
  for (const c of pool) {
    if (isBetterSnippet(c, best)) best = c;
  }
  return { context: clampSnippet(best.snippet), pmid: best.pmid };
}
