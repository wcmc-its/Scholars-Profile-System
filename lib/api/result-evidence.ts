/**
 * #824 follow-up — the coherent search-result "evidence" model (Phase 1 of the
 * `docs/search-snippet-handoff.md` §4 redesign). Replaces the layered priority
 * chain in `people-result-card.tsx` (method > topic > legacy reason > bio
 * highlight > humanized areas — accreted across ~7 issues) with ONE typed
 * evidence object per result, selected by ONE documented precedence function
 * server-side, rendered by ONE component. Behind `SEARCH_RESULT_EVIDENCE`.
 *
 * Design (handoff §4):
 *   1. One typed `ResultEvidence` per result; the card never re-derives priority.
 *   2. Strongest-evidence-for-this-query precedence, defined once + tested:
 *        name → method → topic → publications:tagged → selfDescription (bio)
 *        → publications:mention → affiliation → areas → none
 *      Two strong/weak splits (§5.0C): `name` (strongest) floats above `method`
 *      while `affiliation` (weak/organizational) sinks just above empty; tagged
 *      pub sits ABOVE bio while a free-text mention sits BELOW it.
 *   3. Always bounded — every payload caps (tools ≤3, areas ≤4, one sentence).
 *   4. Cross-tab: Publications/Funding consume the SAME contract (their kinds are
 *      enumerated below as stubs so Phase 2 doesn't have to break the shape).
 *
 * Pure + client-safe (no DB / `server-only`): `selectEvidence` runs server-side
 * in `searchPeople`, but the type and the pure helpers are imported by the
 * `<ResultEvidence>` client component and the unit tests.
 */

/** A bounded representative publication (carried for a future hover; Phase 1
 *  renders count-only — handoff Case C "C1 default"). */
export type EvidencePub = {
  pmid: string;
  title: string;
  /** Title with the literal query wrapped in `<mark>` when it appeared there. */
  titleHtml?: string;
  year?: number | null;
};

/**
 * The discriminated evidence union. People-tab kinds are produced by
 * {@link selectEvidence}; the Funding/Publications kinds at the bottom are
 * Phase-2 STUBS — enumerated now (handoff §5#3) so the contract is not
 * People-shaped, but not yet constructed by any selector.
 */
export type ResultEvidence =
  // ── People kinds (Phase 1) ───────────────────────────────────────────────
  /** Exact match on the person's name (strongest signal). `html` is the
   *  `preferredName` highlight fragment, mark in the NAME segment. */
  | { kind: "name"; html: string }
  /** Matched method family + ≤3 cleaned exemplar tools (#824 §4c derive). */
  | { kind: "method"; family: string; tools: string[] }
  /** Matched curated research-area parent topic (v1 keeps the parent label).
   *  `id` is the topic SLUG (= `Topic.id` = `PublicationTopic.parentTopicId`) so
   *  the hover can resolve the scholar's representative paper in this topic. */
  | { kind: "topic"; label: string; id: string }
  /** Publication-count evidence. `strength` ranks it: `tagged` (subject tag,
   *  strong) above bio; `mention` (free-text, weak) below bio; `concept` is the
   *  MeSH-expansion text variant (handoff Case F — folded in, no own kind).
   *  `pubs` carries up to 3 representative papers for the disclosure, `count` the
   *  numeric "N" for the `+N more` math (the human "N of M" string lives in `text`). */
  | {
      kind: "publications";
      strength: "tagged" | "mention" | "concept";
      text: string;
      pubs?: EvidencePub[];
      count?: number;
    }
  /** A genuine sentence from the scholar's overview (matched term bold). */
  | { kind: "selfDescription"; html: string }
  /** Match on the org unit embedded in `preferredName` (weak/organizational —
   *  may be an administrator; handoff Edge G). `html` is the fragment, mark in
   *  the ORG segment. */
  | { kind: "affiliation"; html: string }
  /** Self-reported research areas — NOT a "why this matched" reason but a
   *  "who is this" hint (handoff Case E / §5.0B). Bounded to {@link AREAS_CAP};
   *  `total` drives "+N more". No `matchedIndex` — it is provably always -1 in
   *  this slot (handoff §5.0A: a matched area is promoted to a `topic` badge
   *  before it can reach here), so the field is intentionally absent. */
  | { kind: "areas"; labels: string[]; total: number }
  /** Top MeSH "concepts" — like `areas`, a "who is this" hint, not a "why this
   *  matched" reason, but sourced from the scholar's TOP MeSH descriptors by
   *  publication frequency (denser than the often-sparse self-reported areas).
   *  Behind `SEARCH_PEOPLE_CONCEPT_HINT`; supersedes the `areas` hint when on.
   *  Bounded by the caller; `total` drives "+N more". */
  | { kind: "concepts"; labels: string[]; total: number }
  /** Nothing renderable matched. Under E2 the card shows an honest-empty line. */
  | { kind: "none" }
  // ── Publications/Funding kinds (Phase 2 STUBS — handoff §5#3) ─────────────
  // Enumerated to keep the contract cross-tab; no selector emits these yet.
  /** Funding tab: the scholar's role on the matched award. */
  | { kind: "fundingRole"; role: "pi" | "co-investigator" | "other"; text: string }
  /** Funding tab: the matched award's dollar amount. */
  | { kind: "awardAmount"; text: string };

export type ResultEvidenceKind = ResultEvidence["kind"];

/** Areas hint cap (handoff §5#2 — N=4; labels run ~40 chars with internal
 *  commas, so more guarantees a 2-line wrap and defeats density). */
export const AREAS_CAP = 4;

/** Max length of a bio sentence before the run-on guard trims it (Case D). */
const BIO_MAX_LEN = 200;

/**
 * Distinctive leading platform tokens for the exemplar-tool cleaning rule
 * (clause 3). When a tool name LEADS with one of these, the platform token IS
 * the canonical short form ("10x single-cell transcriptome analysis" → "10x").
 * Conservative on purpose — only well-known platforms, matched case-insensitively
 * as the leading token, so a generic first word is never mistaken for one.
 */
const PLATFORM_TOKENS = [
  "10x",
  "Visium",
  "Slide-seq",
  "Slide-seqV2",
  "Smart-seq",
  "Smart-seq2",
  "Smart-seq3",
  "Drop-seq",
  "inDrop",
  "CITE-seq",
  "MERFISH",
  "seqFISH",
  "Stereo-seq",
  "GeoMx",
  "CosMx",
  "SPLiT-seq",
] as const;

const stripParen = (s: string): string => s.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Extract a parenthetical short-form ("…(SnISOr-Seq)" → "SnISOr-Seq") when one
 *  is present and looks like an ABBREVIATION, not prose. Returns null otherwise. */
function parentheticalShortForm(s: string): string | null {
  const m = s.match(/\(([^)]{1,24})\)/);
  if (!m) return null;
  const inner = m[1].trim();
  // A real short form is a single token (no internal whitespace): "scRNA-seq",
  // "SnISOr-Seq". Reject prose parentheticals — "(see below)", "(cell lines)",
  // "(workflow overview)" — which would otherwise surface as a garbage tool chip.
  if (!inner || /\s/.test(inner)) return null;
  return inner;
}

/** Leading distinctive platform token, canonical-cased, or null. */
function leadingPlatformToken(s: string): string | null {
  const first = s.trim().split(/[\s,]+/)[0] ?? "";
  const lc = first.toLowerCase();
  for (const tok of PLATFORM_TOKENS) {
    if (tok.toLowerCase() === lc) return tok;
  }
  return null;
}

/**
 * #824 follow-up — refine one raw `scholar_family.exemplarTools` list into ≤3
 * DENSE display tokens (handoff §6 Case A, 4 clauses), reproducing the mockup's
 * density ALGORITHMICALLY (no hand-maintained alias map across ~942 families):
 *   1. Drop a tool that merely restates the family; if it restates the family
 *      AND carries a parenthetical, use the parenthetical
 *      ("Single-cell RNA sequencing (scRNA-seq)" → "scRNA-seq").
 *   2. Prefer a leading platform token ("10x single-cell …" → "10x").
 *   3. Prefer a parenthetical short form ("…(SnISOr-Seq)" → "SnISOr-Seq").
 *   4. Else strip parens + cap at 4 words.
 * Then dedupe (case-insensitive) + cap at `limit` (3). Distinct from the legacy
 * `cleanExemplarTools` (dedupe+cap only) so the off-flag staging path is unchanged.
 */
export function refineExemplarTools(family: string, raw: unknown, limit = 3): string[] {
  if (!Array.isArray(raw)) return [];
  const fam = normalize(family);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    let name = String(t).trim();
    if (!name) continue;

    const restatesFamily = normalize(stripParen(name)) === fam;
    const paren = parentheticalShortForm(name);
    const platform = leadingPlatformToken(name);

    if (restatesFamily) {
      // Pure restatement with no short form → drop entirely; with one → use it.
      if (!paren) continue;
      name = paren;
    } else if (platform) {
      name = platform;
    } else if (paren) {
      name = paren;
    } else {
      name = stripParen(name).split(/\s+/).slice(0, 4).join(" ");
    }

    name = name.trim();
    // Drop a token with no alphanumeric content (a lone "," / "-" survives the
    // clauses above as a 1-word "tool"); never render a punctuation-only chip.
    if (!name || !/[a-z0-9]/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

const visibleLen = (s: string): string => s.replace(/<\/?mark>/g, "");

/**
 * Run-on guard for the bio sentence. MARK-AWARE: bounds the VISIBLE length to
 * `maxLen` without ever cutting inside a `<mark>` span (which would leave an
 * unbalanced/truncated tag that the renderer prints as literal `<mark>` text —
 * the exact #1051-class failure the contract exists to prevent). When the marked
 * region sits past the budget, windows AROUND it (so the matched term is never
 * silently dropped) and snaps the edges to word boundaries with an ellipsis.
 * Input must already have NON-mark tags stripped (only `<mark>`/`</mark>` remain).
 *
 * EXPORTED for the funding-tab text-evidence snippet (Tier 3 — issue funding
 * `SEARCH_FUNDING_TEXT_EVIDENCE`), which reuses it from `search-funding.ts` to
 * clamp abstract/keyword/sponsor highlight fragments. Output always has balanced
 * `<mark>`/`</mark>` tags. Behaviour unchanged for existing in-module callers
 * (`firstMatchingSentence`); the `export` keyword is the only edit.
 */
export function clampAroundMarks(s: string, maxLen: number): string {
  if (visibleLen(s).length <= maxLen) return s;

  const firstMark = s.indexOf("<mark>");
  const lastClose = s.lastIndexOf("</mark>");
  const wordTrimEnd = (x: string) => x.replace(/\s+\S*$/, "").trimEnd();
  const wordTrimStart = (x: string) => x.replace(/^\S*\s+/, "");

  if (firstMark === -1 || lastClose === -1) {
    return wordTrimEnd(s.slice(0, maxLen)) + "…";
  }
  // The whole marked region (first <mark> … last </mark>), kept verbatim.
  const region = s.slice(firstMark, lastClose + "</mark>".length);
  const regionVisible = visibleLen(region).length;
  if (regionVisible >= maxLen) return region.trim();

  const budget = maxLen - regionVisible;
  const beforeBudget = Math.ceil(budget / 2);
  const afterBudget = budget - beforeBudget;
  // `before`/`after` are tag-free (non-mark stripped; all marks are in `region`),
  // so word-boundary slicing here cannot cut a tag.
  let before = s.slice(0, firstMark);
  let after = s.slice(lastClose + "</mark>".length);
  if (before.length > beforeBudget) before = "…" + wordTrimStart(before.slice(before.length - beforeBudget));
  if (after.length > afterBudget) after = wordTrimEnd(after.slice(0, afterBudget)) + "…";
  return (before + region + after).trim();
}

/**
 * Trim an OpenSearch highlight FRAGMENT (char-bounded, often mid-word, and
 * possibly carrying raw bio HTML) to the first whole sentence containing the
 * `<mark>` match, with a mark-aware run-on guard (handoff Case D). Strips
 * non-mark tags up front so the only markup is balanced `<mark>` spans.
 */
export function firstMatchingSentence(fragment: string): string {
  const cleaned = fragment.replace(/<(?!\/?mark\b)[^>]*>/gi, "").trim();
  const markStart = cleaned.indexOf("<mark>");
  if (markStart === -1) return clampAroundMarks(cleaned, BIO_MAX_LEN);

  // Sentence start = just after the LAST sentence terminator before the mark
  // (a closing quote/paren may trail the terminator); else the fragment start.
  const before = cleaned.slice(0, markStart);
  let start = 0;
  const boundary = /[.!?]["')\]]?\s+/g;
  let b: RegExpExecArray | null;
  while ((b = boundary.exec(before)) !== null) start = b.index + b[0].length;

  // Sentence end = first terminator at/after the mark's end, INCLUDING a
  // trailing closing quote/bracket (capture it so it isn't truncated).
  const markEnd = cleaned.indexOf("</mark>", markStart);
  const fromIdx = markEnd === -1 ? markStart : markEnd + "</mark>".length;
  const after = cleaned.slice(fromIdx);
  const endMatch = /[.!?](["')\]]?)(?:\s|$)/.exec(after);
  const end = endMatch ? fromIdx + endMatch.index + 1 + endMatch[1].length : cleaned.length;

  return clampAroundMarks(cleaned.slice(start, end).trim(), BIO_MAX_LEN);
}

/**
 * Classify a `preferredName` highlight fragment as a `name` match (mark in the
 * person-name segment) vs an `affiliation` match (mark in the org unit embedded
 * after the " - " separator, e.g. "Roel van Herten - AI In Medical Imaging").
 * `deptName` is never highlighted (only `preferredName` + `overview`), so the
 * org is detected INSIDE the name string. No " - " ⇒ the whole string is the
 * name ⇒ `name`. Returns null when there is no `<mark>` at all.
 */
export function classifyNameHighlight(fragment: string): "name" | "affiliation" | null {
  const markIdx = fragment.indexOf("<mark>");
  if (markIdx === -1) return null;
  const sepIdx = fragment.indexOf(" - ");
  if (sepIdx === -1) return "name";
  // A mark anywhere in the name segment wins (name is the stronger signal even
  // if the query also hit the org).
  return markIdx < sepIdx ? "name" : "affiliation";
}

/** The per-hit signals `searchPeople` resolves and hands to {@link selectEvidence}.
 *  Every field is already overlay-gated / bounded by the caller. */
export type SelectEvidenceInput = {
  /** `hl.preferredName?.[0]` — the KEYED highlight (not the flattened array),
   *  so name vs affiliation can be told apart. */
  nameHighlight?: string;
  /** `hl.overview?.[0]` — the bio highlight fragment. */
  bioHighlight?: string;
  /** Resolved method-family reason (overlay-gated), tools already refined. */
  method?: { family: string; tools: string[] };
  /** Resolved matched parent topic — `label` for display, `id` (slug) for the
   *  representative-paper hover. */
  topic?: { label: string; id: string };
  /** Pre-formatted publication-evidence parts (counts already capped, text
   *  already built; any one may be absent). `count` is the numeric "N" (the
   *  `+N more` math), `pubs` up to 3 representative papers for the disclosure. */
  pub?: {
    tagged?: { text: string; count: number; pubs?: EvidencePub[] };
    mention?: { text: string; count: number; pubs?: EvidencePub[] };
    concept?: { text: string };
  };
  /** The content query (the literal free-text terms the search ran against),
   *  used by the bio-vs-pub precedence split: a bio highlight that covered only a
   *  SUBSET of a multi-word query loses to publication-mention evidence (handoff
   *  decision 2). Absent ⇒ no demotion (back-compat). */
  query?: string;
  /** Bounded research-areas hint (labels already capped to {@link AREAS_CAP},
   *  `total` is the full count). */
  areas?: { labels: string[]; total: number } | null;
  /** Bounded top-MeSH-concepts hint (labels already capped by the caller,
   *  `total` is the full count). When present + non-empty it supersedes `areas`
   *  in the tail (step 8a above 8b). Behind `SEARCH_PEOPLE_CONCEPT_HINT`; absent
   *  ⇒ today's `areas` tail (back-compat). */
  concepts?: { labels: string[]; total: number } | null;
};

/**
 * Handoff decision 2 — does the bio highlight cover the WHOLE content query?
 * Tokenize `query` (lowercase, split on non-alphanumeric, drop tokens < 2 chars)
 * and extract the text inside every `<mark>…</mark>` span in `bioHighlight`
 * (lowercased, concatenated); return true iff EVERY query token appears in that
 * marked text. A query with ≤1 significant token → true (a single-token bio match
 * is "full"). Empty/absent query → true (back-compat: no demotion). Pure +
 * client-safe (imported by the selector and the unit tests).
 */
export function bioCoversQuery(bioHighlight: string, query: string): boolean {
  const tokens = (query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  // ≤1 significant token ⇒ a single-token bio match is "full" (no demotion).
  if (tokens.length <= 1) return true;
  const marked = (bioHighlight.match(/<mark>([\s\S]*?)<\/mark>/gi) ?? [])
    .map((m) => m.replace(/<\/?mark>/gi, ""))
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => marked.includes(t));
}

/**
 * THE precedence function (handoff §4 principle 2). Returns exactly one
 * `ResultEvidence`, strongest-first. Order is the single source of truth for
 * "why this matched"; the card renders the result and never re-ranks.
 */
export function selectEvidence(input: SelectEvidenceInput): ResultEvidence {
  const nameKind = input.nameHighlight ? classifyNameHighlight(input.nameHighlight) : null;

  // 1 — name (strongest)
  if (nameKind === "name") return { kind: "name", html: input.nameHighlight! };
  // 2 — method
  if (input.method) return { kind: "method", family: input.method.family, tools: input.method.tools };
  // 3 — topic
  if (input.topic) return { kind: "topic", label: input.topic.label, id: input.topic.id };
  // 4 — publications, strong tier (above bio): tagged subject match, then the
  // `concept` MeSH-expansion text variant — both fold into the tagged tier per
  // the handoff precedence (`publications:tagged (+concept text variant)`), and
  // both ranked the bio in the legacy chain.
  if (input.pub?.tagged)
    return {
      kind: "publications",
      strength: "tagged",
      text: input.pub.tagged.text,
      ...(input.pub.tagged.pubs && input.pub.tagged.pubs.length > 0 ? { pubs: input.pub.tagged.pubs } : {}),
      count: input.pub.tagged.count,
    };
  if (input.pub?.concept) return { kind: "publications", strength: "concept", text: input.pub.concept.text };
  // 5 — selfDescription (bio) — ONLY when the bio covered the WHOLE query (a
  // FULL-query / single-token bio match still wins, as today). A partial-bio
  // match falls through to 6 (pub.mention) so a real subset-only highlight never
  // outranks publication-mention evidence (handoff decision 2).
  if (input.bioHighlight && bioCoversQuery(input.bioHighlight, input.query ?? ""))
    return { kind: "selfDescription", html: firstMatchingSentence(input.bioHighlight) };
  // 6 — publications:mention (free-text, weak — below a FULL bio match so
  // "1 of 133 mention" never outranks a real overview sentence; handoff §5.0C —
  // but a PARTIAL-only bio match has fallen through above and loses to this).
  if (input.pub?.mention)
    return {
      kind: "publications",
      strength: "mention",
      text: input.pub.mention.text,
      ...(input.pub.mention.pubs && input.pub.mention.pubs.length > 0 ? { pubs: input.pub.mention.pubs } : {}),
      count: input.pub.mention.count,
    };
  // 6b — selfDescription (bio) — the partial-bio match that lost to pub.mention
  // above still beats affiliation/areas/empty, so it falls here.
  if (input.bioHighlight) return { kind: "selfDescription", html: firstMatchingSentence(input.bioHighlight) };
  // 7 — affiliation (weak/organizational, just above empty)
  if (nameKind === "affiliation") return { kind: "affiliation", html: input.nameHighlight! };
  // 8a — concepts (top-MeSH who-is-this hint; supersedes areas when present,
  // behind SEARCH_PEOPLE_CONCEPT_HINT — the caller sets `concepts` and nulls
  // `areas` only when the flag is on, so off-flag this branch never fires)
  if (input.concepts && input.concepts.labels.length > 0)
    return { kind: "concepts", labels: input.concepts.labels, total: input.concepts.total };
  // 8b — areas (legacy who-is-this hint; E2 renders it OUTSIDE the match slot)
  if (input.areas && input.areas.labels.length > 0)
    return { kind: "areas", labels: input.areas.labels, total: input.areas.total };
  // 9 — honest empty
  return { kind: "none" };
}
