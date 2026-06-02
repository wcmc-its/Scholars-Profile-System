/**
 * Types + pure transforms for the PARAMETRIC-prose instrument (#594 §3) — the
 * lagging, diagnostic companion to the citation-RAG tracker in `llm-rank.ts`.
 *
 * Where citation-RAG asks "does a browsing assistant CITE a WCM profile",
 * parametric prose asks the *vanilla* model (no web tools) "who's an expert in
 * X" and parses the answer for whether WCM — the institution, or a specific WCM
 * scholar — is even NAMED, and how prominently. This reflects the model's
 * training-data prior, so it lags training cutoffs by months and is explicitly
 * NOT a launch metric (the issue's §3 is build-but-don't-gate). It's the "does
 * the model know WCM exists in this field at all" floor.
 *
 * Detection here is PURE and network-free (unit-tested without API calls). The
 * LLM-as-judge prominence rubric is a network call that lives in the script;
 * this module only merges a supplied judge score.
 */
import { wilsonInterval, type RateCI } from "./llm-rank";

/** What "WCM" looks like in prose, plus the roster used for detection. */
export interface MentionTargets {
  /** WCM institution aliases, e.g. ["Weill Cornell Medicine", "Weill Cornell", "WCM"]. */
  institutionNames: string[];
  /** Optional WCM scholar-name roster; empty → scholar detection is skipped. */
  scholarNames?: string[];
  /** The new-site host, e.g. "scholars.weill.cornell.edu" (rare in parametric prose, but recorded). */
  scholarsHost: string;
  /** Peer institution names — WCM's first-mention rank among these is the deterministic prominence. */
  competitorNames?: string[];
}

/** Deterministic detection over one parametric answer. */
export interface MentionResult {
  /** WCM the institution was named. */
  institutionNamed: boolean;
  /** At least one rostered WCM scholar was named. */
  scholarNamed: boolean;
  /** Which rostered scholars appeared (in first-seen order). */
  namedScholars: string[];
  /** A scholars.weill.cornell.edu URL appeared (uncommon without browsing, but recorded). */
  scholarsHostCited: boolean;
  /**
   * 1-based rank of WCM's first mention among {WCM + competitors}, ordered by
   * text position — a deterministic prominence proxy. null if WCM isn't named.
   * The optional LLM judge can override with a richer score.
   */
  prominenceOrdinal: number | null;
  /** Char index of WCM's first mention (institution or scholar), for auditing. null if absent. */
  firstMentionIndex: number | null;
}

/** Strip diacritics + lowercase so "Iadecola" matches "Iádecola", etc. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First character index at which any of `names` appears in `haystack`, matched
 * on word boundaries (so "WCM" doesn't fire inside "AWCMX" and "Weill Cornell"
 * matches as a phrase), case/diacritic-insensitive. Returns -1 if none appear.
 */
function firstIndexOfAny(haystack: string, names: string[]): number {
  const hay = fold(haystack);
  let best = -1;
  for (const name of names) {
    const n = fold(name).trim();
    if (!n) continue;
    const m = new RegExp(`\\b${escapeRegExp(n)}\\b`).exec(hay);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

/**
 * Detect WCM in one parametric-prose answer. Pure: all signals derive from the
 * text plus the supplied roster — no model calls, no hardcoded names.
 */
export function detectMention(prose: string, targets: MentionTargets): MentionResult {
  const instIdx = firstIndexOfAny(prose, targets.institutionNames);
  const institutionNamed = instIdx !== -1;

  const namedScholars: string[] = [];
  let scholarFirstIdx = -1;
  for (const name of targets.scholarNames ?? []) {
    const idx = firstIndexOfAny(prose, [name]);
    if (idx !== -1) {
      namedScholars.push(name);
      if (scholarFirstIdx === -1 || idx < scholarFirstIdx) scholarFirstIdx = idx;
    }
  }
  const scholarNamed = namedScholars.length > 0;

  // First WCM mention = earliest of institution / any scholar.
  const wcmIdxs = [instIdx, scholarFirstIdx].filter((i) => i !== -1);
  const firstMentionIndex = wcmIdxs.length ? Math.min(...wcmIdxs) : null;

  const scholarsHostCited = fold(prose).includes(fold(targets.scholarsHost));

  // Prominence: rank WCM's first mention among {WCM, ...competitors} by position.
  let prominenceOrdinal: number | null = null;
  if (firstMentionIndex !== null) {
    let ahead = 0;
    for (const comp of targets.competitorNames ?? []) {
      const ci = firstIndexOfAny(prose, [comp]);
      if (ci !== -1 && ci < firstMentionIndex) ahead++;
    }
    prominenceOrdinal = ahead + 1;
  }

  return {
    institutionNamed,
    scholarNamed,
    namedScholars,
    scholarsHostCited,
    prominenceOrdinal,
    firstMentionIndex,
  };
}

// ── snapshot shape (mirrors llm-rank, reuses Wilson CI) ─────────────────────

/** A judge's prominence read merged onto the deterministic detection. */
export interface JudgedMention extends MentionResult {
  /** LLM-as-judge prominence score (0 = absent … 3 = led with WCM), if run. */
  judgeScore?: number;
  judgeRationale?: string;
}

export interface MentionSample {
  sampleIndex: number;
  prose: string;
  result: JudgedMention;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  generationId?: string | null;
}

/** Run identity — the §4 drift controls, parametric variant. */
export interface MentionRunMeta {
  provider: string;
  model: string;
  modelDate: string | null;
  temperature: number;
  samples: number;
  queryBasketSha: string;
  surface: "parametric";
  /** Judge model, if a prominence rubric was applied. */
  judgeModel?: string | null;
}

/** Aggregated mention rates for one (query, provider) over N samples. */
export interface MentionRow {
  id: string;
  query: string;
  label?: string;
  provider: string;
  samples: number;
  /** Wilson rate+CI that WCM the institution was named. */
  institutionNamed: RateCI & { count: number };
  /** Wilson rate+CI that a specific WCM scholar was named. */
  scholarNamed: RateCI & { count: number };
  /** Median deterministic prominence ordinal among samples where WCM was named. */
  medianProminence: number | null;
  /** Mean judge score among judged samples, or null. */
  meanJudgeScore: number | null;
  rawSamples: MentionSample[];
}

export interface MentionSnapshot {
  capturedAt: string;
  basketSource: string;
  runs: MentionRunMeta[];
  rows: MentionRow[];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(nums: number[]): number | null {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Roll N parametric samples into one row (rate+CI for named-ness, prominence, judge). */
export function aggregateMentionSamples(
  id: string,
  query: string,
  label: string | undefined,
  provider: string,
  samples: MentionSample[],
): MentionRow {
  const n = samples.length;
  const instCount = samples.filter((s) => s.result.institutionNamed).length;
  const schCount = samples.filter((s) => s.result.scholarNamed).length;
  const proms = samples
    .map((s) => s.result.prominenceOrdinal)
    .filter((p): p is number => p !== null);
  const judges = samples
    .map((s) => s.result.judgeScore)
    .filter((j): j is number => typeof j === "number");
  return {
    id,
    query,
    label,
    provider,
    samples: n,
    institutionNamed: { count: instCount, ...wilsonInterval(instCount, n) },
    scholarNamed: { count: schCount, ...wilsonInterval(schCount, n) },
    medianProminence: median(proms),
    meanJudgeScore: mean(judges),
    rawSamples: samples,
  };
}
