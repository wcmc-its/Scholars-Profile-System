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
  const noParens = lower.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (noParens.length >= 3 && noParens !== lower) forms.add(noParens);
  return [...forms];
}

function namesTool(snippet: string, forms: string[]): boolean {
  if (forms.length === 0) return false;
  const s = snippet.toLowerCase();
  return forms.some((f) => s.includes(f));
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
 */
export function selectBestSnippet(
  index: ToolContextIndex,
  toolId: string,
  opts?: { displayName?: string | null; scholarPmids?: ReadonlySet<string> },
): BestSnippet | null {
  const survivors = index.byTool.get(toolId);
  if (!survivors || survivors.length === 0) return null;

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
    if (named.length > 0) pool = named;
  }

  // Longest (by RAW length, before clamping), tie-broken by pmid asc → deterministic.
  let best = pool[0];
  for (const c of pool) {
    if (
      c.snippet.length > best.snippet.length ||
      (c.snippet.length === best.snippet.length && c.pmid < best.pmid)
    ) {
      best = c;
    }
  }
  return { context: clampSnippet(best.snippet), pmid: best.pmid };
}
