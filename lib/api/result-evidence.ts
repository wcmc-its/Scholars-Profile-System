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
 *        name → method → {publications:tagged ⇄ clinical:exact, COUNT-GATED}
 *        → publications:concept → selfDescription (bio) → publications:mention
 *        → topic → affiliation → concepts → areas → none
 *      (clinical:exact outranks tagged only when the tagged pub count is below an
 *       env-tunable threshold — higher for a board cert than a bare specialty.)
 *      Two strong/weak splits (§5.0C): `name` (strongest) floats above `method`
 *      while `affiliation` (weak/organizational) sinks just above empty; tagged
 *      pub sits ABOVE bio while a free-text mention sits BELOW it. `topic` (the
 *      research area) is demoted below ALL query-literal evidence — a direct
 *      MeSH/method hit, a bio sentence, or a paper mention — because the area's
 *      displayed PARENT label can read as unrelated (a "stem cells" subarea under
 *      a "Gastroenterology" parent), so it must never mask a card that literally
 *      shows the search term. It is still a real query match, so it stays above
 *      org-affiliation + the identity hints — just the least self-evident one.
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

/** A bounded representative grant for the "Key funding" disclosure — the funding
 *  analogue of {@link EvidencePub}. Lazily loaded by `/api/scholar/[cwid]/grants`. */
export type EvidenceGrant = {
  /** Account_Number dedupe key from the funding index (FundingHit.projectId). */
  projectId: string;
  title: string;
  /** #1359 — the grant title with the matched query term(s) wrapped in `<mark>`,
   *  from `searchFunding`'s highlighter; null when nothing matched in the title.
   *  Rendered with the same pill styling as key-paper titles. */
  titleHighlight?: string | null;
  /** Prime sponsor display label, e.g. "NIH / NIA"; null when unknown. */
  sponsor?: string | null;
  /** Award period years (YYYY) parsed from start/end dates; either may be null. */
  startYear?: number | null;
  endYear?: number | null;
  isActive?: boolean;
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
  /** Matched method family + ≤3 cleaned exemplar tools (#824 §4c derive).
   *  `count` (#1366) — the family's distinct-pub count `N` for the "N of M
   *  publications" reason-line prefix; set ONLY on the stacked-lines path
   *  (`selectEvidenceLines`, behind SEARCH_EVIDENCE_REASON_COUNTS). Absent on the
   *  single-evidence `selectEvidence` path, so the off-flag render is unchanged. */
  | { kind: "method"; family: string; tools: string[]; count?: number }
  /** Clinical specialty match (exact tier only — see {@link clinicalExactMatch}).
   *  `boardCertified` true iff the specialty is in the scholar's board-cert set;
   *  the label renders as "Board certified in {specialty}" vs "Clinical specialty:
   *  {specialty}" accordingly. Loose specialty matches contribute to ranking but
   *  emit no reason (under-claim rather than mislabel). */
  | { kind: "clinical"; specialty: string; boardCertified: boolean }
  /** Matched curated research-area parent topic (v1 keeps the parent label).
   *  `id` is the topic SLUG (= `Topic.id` = `PublicationTopic.parentTopicId`) so
   *  the hover can resolve the scholar's representative paper in this topic.
   *  `count` (#1366) — distinct on-topic-pub count `N` for the "N of M
   *  publications" prefix; set ONLY on the stacked-lines path. */
  | { kind: "topic"; label: string; id: string; count?: number }
  /** Publication-count evidence. `strength` ranks it: `tagged` (subject tag,
   *  strong) above bio; `mention` (free-text, weak) below bio; `concept` is the
   *  MeSH-expansion text variant (handoff Case F — folded in, no own kind).
   *  `pubs` carries up to 3 representative papers for the disclosure, `count` the
   *  numeric "N" for the `+N more` math (the human "N of M" string lives in `text`). */
  | {
      kind: "publications";
      strength: "tagged" | "mention" | "concept";
      text: string;
      /** #1350 — the resolved concept term named at the END of `text` (so `text`
       *  is just the prefix, e.g. "3 of 301 publications tagged"). Set for the
       *  `tagged`/`concept` strengths; the renderer gives it a subtle underline.
       *  Absent for `mention` (the literal query, already quoted in `text`). */
      term?: string;
      /** #1355 — narrower descendant descriptors the scholar actually carries,
       *  when the resolved concept matched via a strictly-narrower term. Rendered
       *  as "(matched X, Y)" after the term. Absent on a direct concept match. */
      descendantTerms?: string[];
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
   *  Each item carries the MeSH descriptor `ui` so the chip can deep-link to the
   *  scholar's publications pre-filtered to that concept (`?mesh=<ui>`); `ui` is
   *  null for the rare label that didn't resolve to a descriptor (renders as a
   *  non-link). The full set is sent; the client measures + folds to "+N more".
   *  `total` (= items.length) drives the count. */
  | { kind: "concepts"; items: Array<{ label: string; ui: string | null }>; total: number }
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
  /** Resolved method-family reason (overlay-gated), tools already refined.
   *  `count` (#1366) — distinct-pub count for the stacked-lines prefix; ignored
   *  by `selectEvidence` (single path), read by `selectEvidenceLines`. */
  method?: { family: string; tools: string[]; count?: number };
  /** Resolved matched parent topic — `label` for display, `id` (slug) for the
   *  representative-paper hover. `count` (#1366) — as `method.count`. */
  topic?: { label: string; id: string; count?: number };
  /** Pre-formatted publication-evidence parts (counts already capped, text
   *  already built; any one may be absent). `count` is the numeric "N" (the
   *  `+N more` math), `pubs` up to 3 representative papers for the disclosure. */
  pub?: {
    tagged?: { text: string; term?: string; descendantTerms?: string[]; count: number; pubs?: EvidencePub[] };
    mention?: { text: string; term?: string; count: number; pubs?: EvidencePub[] };
    concept?: { text: string; term?: string; descendantTerms?: string[] };
  };
  /** Resolved clinical specialty — exact tier only. Caller ran
   *  {@link clinicalExactMatch} against the hit's `_source` clinical fields; pass
   *  the non-null result here. Absent ⇒ no clinical reason (loose matches are
   *  intentionally silent; they still contribute to the multi_match score). */
  clinical?: { specialty: string; boardCertified: boolean };
  /** Count thresholds for the clinical:exact-vs-publications:tagged precedence
   *  (env-tunable). clinical:exact outranks a `tagged` reason only when the tagged
   *  pub count is below `boardOverTagged` (board-certified match) or
   *  `specialtyOverTagged` (specialty-only). Absent ⇒ tagged always wins when
   *  present (clinical fills in only when there are no tagged pubs). */
  clinicalReasonThresholds?: { boardOverTagged: number; specialtyOverTagged: number };
  /** The content query (the literal free-text terms the search ran against),
   *  used by the bio-vs-pub precedence split: a bio highlight that covered only a
   *  SUBSET of a multi-word query loses to publication-mention evidence (handoff
   *  decision 2). Absent ⇒ no demotion (back-compat). */
  query?: string;
  /** Bounded research-areas hint (labels already capped to {@link AREAS_CAP},
   *  `total` is the full count). */
  areas?: { labels: string[]; total: number } | null;
  /** Top-MeSH-concepts hint — the FULL set of {label, ui} items (the client
   *  measures + folds to "+N more"), `total` = items.length. When present +
   *  non-empty it supersedes `areas` in the tail (step 8a above 8b). Behind
   *  `SEARCH_PEOPLE_CONCEPT_HINT`; absent ⇒ today's `areas` tail (back-compat). */
  concepts?: { items: Array<{ label: string; ui: string | null }>; total: number } | null;
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
 * Cheap, pure exact-tier clinical match for the search explanation layer. Run
 * over the hit's `_source` `clinicalSpecialties` field + the content query; the
 * non-null result is passed directly as `clinical` to {@link selectEvidence}.
 *
 * A hit is `clinical:exact` iff, for the first specialty `s` in `specialties`
 * where EITHER:
 *   - **token-subset**: every content token of the normalized query appears in
 *     normalize(s) — the specialty is at least as specific as the query (e.g.
 *     "cardiology" query matches "Interventional Cardiology" specialty), OR
 *   - **phrase equality**: normalize(s) equals the normalized query exactly.
 * `boardCertified` is true iff `s` is case-insensitively present in `boardSet`
 * (the board-certifications-only subset, separate from primary specialties).
 * Returns null when no specialty qualifies — the hit still benefits from the
 * `clinicalSpecialties`/`clinicalExpertise` multi_match boost in the query, but
 * no clinical reason is emitted (conservative: under-claim rather than mislabel).
 *
 * Normalize = lowercase + collapse whitespace (shared with the rest of this module).
 *
 * Known gap (accepted v1): synonym/abbreviation queries ("heart" → Cardiology)
 * won't earn a clinical reason; they still boost ranking via loose match.
 */
export function clinicalExactMatch(
  contentQuery: string,
  specialties: string[],
  boardSet: string[],
): { specialty: string; boardCertified: boolean } | null {
  const nq = normalize(contentQuery);
  const tokens = nq.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || specialties.length === 0) return null;
  const boardNorm = new Set(boardSet.map(normalize));
  for (const s of specialties) {
    const ns = normalize(s);
    if (!ns) continue;
    // token-subset: every query token appears as a substring in the normalized specialty.
    const tokenSubset = tokens.every((t) => ns.includes(t));
    // phrase equality: the normalized specialty IS the normalized query. Prevents
    // "Cardiology" from matching a "pediatric cardiology" query (where the searcher
    // is asking for something more specific than the specialty) via substring.
    const phrase = ns === nq;
    if (tokenSubset || phrase) {
      return { specialty: s, boardCertified: boardNorm.has(ns) };
    }
  }
  return null;
}

/**
 * THE precedence function (handoff §4 principle 2). Returns exactly one
 * `ResultEvidence`, strongest-first. Order is the single source of truth for
 * "why this matched"; the card renders the result and never re-ranks.
 */
export function selectEvidence(input: SelectEvidenceInput): ResultEvidence {
  const nameKind = input.nameHighlight ? classifyNameHighlight(input.nameHighlight) : null;

  // 1 — name: intentionally NOT surfaced as a snippet (#1267). The card already
  // prints the scholar's name as its heading, so a name-kind snippet just repeats
  // it — useless to a searcher. A name-only match falls through to genuinely
  // informative evidence below (method / pub / bio / topic / identity hints), or
  // the honest-empty line. `nameKind` is still read by the rank-7 affiliation branch.
  // 2 — method
  if (input.method) return { kind: "method", family: input.method.family, tools: input.method.tools };
  // 3/4 — clinical:exact vs publications:tagged, COUNT-GATED. A direct MeSH
  // `tagged` hit is the most on-mission signal in a research profile system, so a
  // STRONG tagged signal wins. But a board-cert / primary-specialty match that
  // literally names the query should beat a WEAK tagged signal — "5 pubs > 1
  // specialty, but 3 maybe not", and "board cert > specialty". So clinical:exact
  // outranks tagged only when the tagged pub COUNT is below a threshold that is
  // higher for a board certification than for a bare specialty. Thresholds come
  // from the caller (env-tunable: SEARCH_PEOPLE_CLINICAL_{BOARD,SPECIALTY}_OVER_TAGGED);
  // absent ⇒ {0,0} ⇒ original behavior (tagged always wins when present; clinical
  // fills in only when there are no tagged pubs).
  if (input.clinical) {
    const tagged = input.pub?.tagged;
    const th = input.clinicalReasonThresholds;
    const limit = th ? (input.clinical.boardCertified ? th.boardOverTagged : th.specialtyOverTagged) : 0;
    if (!tagged || tagged.count < limit)
      return { kind: "clinical", specialty: input.clinical.specialty, boardCertified: input.clinical.boardCertified };
    // strong tagged signal ⇒ fall through to the tagged return below.
  }
  // tagged: a DIRECT subject/MeSH hit. Beats a weak/absent clinical match (handled
  // above), `concept`, and `topic` (which can be an unrelated PARENT of the matched
  // subarea — e.g. a "stem cells" subarea under a "Gastroenterology" parent).
  if (input.pub?.tagged)
    return {
      kind: "publications",
      strength: "tagged",
      text: input.pub.tagged.text,
      ...(input.pub.tagged.term ? { term: input.pub.tagged.term } : {}),
      ...(input.pub.tagged.descendantTerms && input.pub.tagged.descendantTerms.length > 0
        ? { descendantTerms: input.pub.tagged.descendantTerms }
        : {}),
      ...(input.pub.tagged.pubs && input.pub.tagged.pubs.length > 0 ? { pubs: input.pub.tagged.pubs } : {}),
      count: input.pub.tagged.count,
    };
  // 5 — publications:concept (MeSH-expansion text variant; below clinical:exact)
  if (input.pub?.concept)
    return {
      kind: "publications",
      strength: "concept",
      text: input.pub.concept.text,
      ...(input.pub.concept.term ? { term: input.pub.concept.term } : {}),
      ...(input.pub.concept.descendantTerms && input.pub.concept.descendantTerms.length > 0
        ? { descendantTerms: input.pub.concept.descendantTerms }
        : {}),
    };
  // 6 — selfDescription (bio) — ONLY when the bio covered the WHOLE query (a
  // FULL-query / single-token bio match still wins, as today). A query-literal
  // bio sentence shows WHY this matched, so it now outranks the research-area
  // `topic` below. A partial-bio match falls through to pub.mention so a real
  // subset-only highlight never outranks publication-mention evidence (decision 2).
  if (input.bioHighlight && bioCoversQuery(input.bioHighlight, input.query ?? ""))
    return { kind: "selfDescription", html: firstMatchingSentence(input.bioHighlight) };
  // 7 — publications:mention (free-text — a paper TITLE/abstract literally mentions
  // the term; below a FULL bio match so "1 of 133 mention" never outranks a real
  // overview sentence; handoff §5.0C — but a PARTIAL-only bio match has fallen
  // through above and loses to this).
  if (input.pub?.mention)
    return {
      kind: "publications",
      strength: "mention",
      text: input.pub.mention.text,
      ...(input.pub.mention.term ? { term: input.pub.mention.term } : {}),
      ...(input.pub.mention.pubs && input.pub.mention.pubs.length > 0 ? { pubs: input.pub.mention.pubs } : {}),
      count: input.pub.mention.count,
    };
  // 8 — topic (matched research area). Demoted below ALL query-literal evidence
  // (MeSH tagged/concept, clinical:exact, a full-query bio sentence, a paper
  // mention): the area's displayed PARENT label can look unrelated, so it must
  // never mask a card that literally shows the search term. Still above the weak
  // subset-only bio match + org-affiliation + identity hints — it IS a real query
  // match, just the least self-evident one.
  if (input.topic) return { kind: "topic", label: input.topic.label, id: input.topic.id };
  // 8b — selfDescription (bio) — the partial-bio match that lost to pub.mention +
  // topic above still beats affiliation/areas/empty, so it falls here.
  if (input.bioHighlight) return { kind: "selfDescription", html: firstMatchingSentence(input.bioHighlight) };
  // 9 — affiliation (weak/organizational, just above empty)
  if (nameKind === "affiliation") return { kind: "affiliation", html: input.nameHighlight! };
  // 10a — concepts (top-MeSH who-is-this hint; supersedes areas when present,
  // behind SEARCH_PEOPLE_CONCEPT_HINT — the caller sets `concepts` and nulls
  // `areas` only when the flag is on, so off-flag this branch never fires)
  if (input.concepts && input.concepts.items.length > 0)
    return { kind: "concepts", items: input.concepts.items, total: input.concepts.total };
  // 10b — areas (legacy who-is-this hint; E2 renders it OUTSIDE the match slot)
  if (input.areas && input.areas.labels.length > 0)
    return { kind: "areas", labels: input.areas.labels, total: input.areas.total };
  // 11 — honest empty
  return { kind: "none" };
}

/**
 * #1366 — the STACKED reason-line variant. Where {@link selectEvidence} returns
 * ONE evidence by strict precedence, this returns an ORDERED LIST in which the
 * first-class research signals — method, a tagged-concept (MeSH) match, and the
 * matched research area — each appear as their OWN line when present (a scholar
 * can match on more than one). `mention` (keyword) is the fallback shown ONLY
 * when none of the three fired; `clinical` is an INDEPENDENT label-only line.
 * When NONE of those fire, it falls back to the single {@link selectEvidence}
 * tail (concept-text / bio / affiliation / identity hints / honest-empty) so a
 * card never loses its existing evidence.
 *
 * Behind SEARCH_EVIDENCE_REASON_COUNTS — the caller uses this instead of
 * `selectEvidence` only when the flag is on, so the off-flag path is unchanged.
 * `count` on method/topic drives the "N of M publications" prefix (the renderer
 * pairs it with the hit's `pubCount`). Pure + client-safe.
 */
export function selectEvidenceLines(input: SelectEvidenceInput): ResultEvidence[] {
  const lines: ResultEvidence[] = [];
  // 1 — method (first-class)
  if (input.method)
    lines.push({
      kind: "method",
      family: input.method.family,
      tools: input.method.tools,
      ...(input.method.count != null ? { count: input.method.count } : {}),
    });
  // 2 — concept: a DIRECT subject/MeSH tagged hit (the counted `tagged` variant;
  // the weaker `concept` text variant stays in the single-tail fallback below).
  if (input.pub?.tagged)
    lines.push({
      kind: "publications",
      strength: "tagged",
      text: input.pub.tagged.text,
      ...(input.pub.tagged.term ? { term: input.pub.tagged.term } : {}),
      ...(input.pub.tagged.descendantTerms && input.pub.tagged.descendantTerms.length > 0
        ? { descendantTerms: input.pub.tagged.descendantTerms }
        : {}),
      ...(input.pub.tagged.pubs && input.pub.tagged.pubs.length > 0 ? { pubs: input.pub.tagged.pubs } : {}),
      count: input.pub.tagged.count,
    });
  // 3 — research area (first-class peer line; demoted-below-all in the single path)
  if (input.topic)
    lines.push({
      kind: "topic",
      label: input.topic.label,
      id: input.topic.id,
      ...(input.topic.count != null ? { count: input.topic.count } : {}),
    });
  // 4 — keyword/mention FALLBACK: only when none of method/concept/area fired.
  if (lines.length === 0 && input.pub?.mention)
    lines.push({
      kind: "publications",
      strength: "mention",
      text: input.pub.mention.text,
      ...(input.pub.mention.term ? { term: input.pub.mention.term } : {}),
      ...(input.pub.mention.pubs && input.pub.mention.pubs.length > 0 ? { pubs: input.pub.mention.pubs } : {}),
      count: input.pub.mention.count,
    });
  // 5 — clinical: an INDEPENDENT label-only line (#1367 — no count), appended
  // whenever a clinical:exact match exists, alongside the lines above.
  if (input.clinical)
    lines.push({
      kind: "clinical",
      specialty: input.clinical.specialty,
      boardCertified: input.clinical.boardCertified,
    });
  // 6 — nothing first-class matched ⇒ the single-evidence tail (concept-text /
  // bio / affiliation / identity hints / honest-empty). It can't return
  // method/topic/tagged/mention/clinical here — all were handled + absent above.
  if (lines.length === 0) lines.push(selectEvidence(input));
  return lines;
}
