import type { AuthorRole } from "@/lib/search-index-docs";

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
  /** The venue. Same wire shape as `RepresentativePub` (`lib/api/search.ts`) — these two types
   *  describe ONE payload, so they widen together or they lie about it. */
  journal?: string;
  /** THIS scholar's authorship role on this paper. Absent = unknown (pre-reindex document, or a
   *  path that does not resolve it) and must never be rendered as "middle author". */
  role?: AuthorRole;
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
  /** THIS scholar's investigator role on the grant, from the funding index's per-person
   *  `FundingPersonChip.role`, picked for the querying cwid. This is the RAW InfoEd
   *  `Grant.role` vocabulary — `PI | PI-Subaward | Co-PI | Co-I | Key Personnel` — NOT
   *  display text: put it through `fundingRoleLabel` / `grantRoleShortLabel`
   *  (lib/funding-roles.ts) before rendering. In particular `Co-PI` is InfoEd's
   *  NON-CONTACT PD/PI of a multiple-PI award and must read as MPI, never "co-PI".
   *  Absent ⇒ unknown (the scholar is on the grant but the index carries no role for
   *  them) and must render nothing, never a default. "Is this scholar the PI, and is the award
   *  still alive" are the two questions a sponsor asks of a grant; `isActive`/`endYear` answer
   *  the second, this answers the first. */
  role?: string | null;
  /** The AWARD carries ≥2 PD/PIs (`FundingHit.isMultiPi`), which is what relabels the
   *  CONTACT PI (`PI` / `PI-Subaward`) as an MPI; a `Co-PI` row is an MPI on its own and
   *  needs this for nothing. Absent ⇒ UNKNOWN, not false: a caller that does not supply it
   *  must render the plain role, never assume a sole-PI award. */
  isMultiPi?: boolean;
  /** The grant was admitted via the resolved MeSH concept, not merely by a literal
   *  text hit (`FundingHit.matchedConcept`). The funding query is an OR — text OR
   *  concept — so a grant can surface having matched nothing but a stray word of the
   *  ask. A concept-captioned block may only lead with a grant this is true for;
   *  see `evidence-line.tsx`. Absent ⇒ unknown, never "yes". */
  matchedConcept?: boolean;
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
   *  emit no reason (under-claim rather than mislabel).
   *  `count`/`eligiblePubCount` (#1367 Gap 1) — DISPLAY-ONLY on-topic pub count
   *  for the "N of M eligible publications" clause. Both absent unless the
   *  specialty has a curated MeSH anchor (`clinical-mesh-anchors.ts`) AND the
   *  doc has been reindexed since #1367 landed; when either is absent the label
   *  renders exactly as before (board-cert/specialty text only, no count clause).
   *  NEVER read by the precedence gates above (`SEARCH_PEOPLE_CLINICAL_
   *  {BOARD,SPECIALTY}_OVER_TAGGED`) — those stay count-blind by design. */
  | {
      kind: "clinical";
      specialty: string;
      boardCertified: boolean;
      count?: number;
      eligiblePubCount?: number;
    }
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
      /** #1955 — whether the resolved parent descriptor is ALSO present in the
       *  scholar's indexed descriptor set, carried alongside {@link descendantTerms}
       *  (never without it) so the People card can word its via-line: additive
       *  ("also tagged") when the parent tag is present, the narrower-route wording
       *  otherwise. NOT symmetric — `false` means absent from the INDEXED set, which
       *  the min-evidence gate in `lib/search-index-docs.ts` makes weaker than absent;
       *  the same field on `MatchProvenance` names the bounded, unfixed residual.
       *  Optional so the other `ResultEvidence`-shaped consumer — `evidenceSummary` in
       *  `components/search/evidence-line.tsx`, which builds its `(matched X · Y)`
       *  parenthetical from `descendantTerms` alone — is untouched; absent is read as
       *  `false`, i.e. the pre-#1955 wording. */
      alsoParent?: boolean;
      /** #2094 — the most recent publication YEAR among the `count` publications
       *  this line counted (NOT among `pubs`, which is a capped sample). Payload
       *  instrumentation for eval panels; nothing renders or ranks on it.
       *  ABSENT ⇒ UNKNOWN — the branch that would have measured it did not run, or
       *  no counted publication carries a year. Never defaulted to 0 or to the
       *  current year; a consumer must handle the absence. */
      latestYear?: number;
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
    tagged?: {
      text: string;
      term?: string;
      descendantTerms?: string[];
      /** #1955 — rides with `descendantTerms` (see the same field on
       *  {@link ResultEvidence}); forwarded verbatim, never re-derived. */
      alsoParent?: boolean;
      count: number;
      /** #2094 — most recent year among the counted pubs; absent ⇒ unknown. See the
       *  same field on {@link ResultEvidence}. Forwarded verbatim, never derived. */
      latestYear?: number;
      pubs?: EvidencePub[];
    };
    mention?: {
      text: string;
      term?: string;
      count: number;
      /** #2094 — as `tagged.latestYear`. */
      latestYear?: number;
      pubs?: EvidencePub[];
    };
    concept?: { text: string; term?: string; descendantTerms?: string[]; alsoParent?: boolean };
  };
  /** Resolved clinical specialty — exact tier only. Caller ran
   *  {@link clinicalExactMatch} against the hit's `_source` clinical fields; pass
   *  the non-null result here. Absent ⇒ no clinical reason (loose matches are
   *  intentionally silent; they still contribute to the multi_match score).
   *  `count`/`eligiblePubCount` (#1367 Gap 1) — DISPLAY-ONLY on-topic pub count +
   *  its eligible-pool denominator, read from the hit's `_source.clinicalOnTopicCounts`
   *  / `_source.meshTaggedPubCount`. Forwarded verbatim onto the constructed
   *  `clinical` evidence; NEVER read by the count-gated precedence logic below
   *  (that stays exactly as it was). */
  clinical?: { specialty: string; boardCertified: boolean; count?: number; eligiblePubCount?: number };
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
      return {
        kind: "clinical",
        specialty: input.clinical.specialty,
        boardCertified: input.clinical.boardCertified,
        // #1367 Gap 1 — display-only; does not affect the gate above.
        ...(input.clinical.count != null ? { count: input.clinical.count } : {}),
        ...(input.clinical.eligiblePubCount != null
          ? { eligiblePubCount: input.clinical.eligiblePubCount }
          : {}),
      };
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
        ? {
            descendantTerms: input.pub.tagged.descendantTerms,
            alsoParent: input.pub.tagged.alsoParent === true,
          }
        : {}),
      ...(input.pub.tagged.latestYear != null ? { latestYear: input.pub.tagged.latestYear } : {}),
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
        ? {
            descendantTerms: input.pub.concept.descendantTerms,
            alsoParent: input.pub.concept.alsoParent === true,
          }
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
      ...(input.pub.mention.latestYear != null ? { latestYear: input.pub.mention.latestYear } : {}),
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
 * Order is method → tagged concept → research area, with ONE exception: a method
 * lead whose count the tagged lead outnumbers swaps with it (see the comment on
 * the swap — a targeted two-way comparison, never a sort).
 * When NONE of those fire, it falls back to the single {@link selectEvidence}
 * tail (concept-text / bio / affiliation / identity hints / honest-empty) so a
 * card never loses its existing evidence.
 *
 * Behind SEARCH_EVIDENCE_REASON_COUNTS — the caller uses this instead of
 * `selectEvidence` only when the flag is on, so the off-flag path is unchanged.
 * `count` on method/topic drives the "N of M publications" prefix (the renderer
 * pairs it with the hit's `pubCount`). Pure + client-safe.
 *
 * Contract: docs/search-relevance-contract.md § Layer 3. Three rules bind here.
 * E1 — a number rendered as query evidence must be COMPUTED UNDER THE QUERY. The `topic`
 *   line currently fails this: its count is an index-time area total, identical whatever
 *   was searched (open violation in that document's register).
 * E2 — a rendered "N of M" takes both sides from one population.
 * E6 — this ordering is STRUCTURAL, not scored. Users read the first line as the primary
 *   reason, but nothing here ranks lines by strength; do not infer that it does.
 */
export function selectEvidenceLines(input: SelectEvidenceInput): ResultEvidence[] {
  const lines: ResultEvidence[] = [];
  // 1 — method (first-class)
  const methodLine: ResultEvidence | undefined = input.method
    ? {
        kind: "method",
        family: input.method.family,
        tools: input.method.tools,
        ...(input.method.count != null ? { count: input.method.count } : {}),
      }
    : undefined;
  // 2 — concept: a DIRECT subject/MeSH tagged hit (the counted `tagged` variant;
  // the weaker `concept` text variant stays in the single-tail fallback below).
  const taggedLine: ResultEvidence | undefined = input.pub?.tagged
    ? {
        kind: "publications",
        strength: "tagged",
        text: input.pub.tagged.text,
        ...(input.pub.tagged.term ? { term: input.pub.tagged.term } : {}),
        ...(input.pub.tagged.descendantTerms && input.pub.tagged.descendantTerms.length > 0
          ? {
              descendantTerms: input.pub.tagged.descendantTerms,
              alsoParent: input.pub.tagged.alsoParent === true,
            }
          : {}),
        ...(input.pub.tagged.latestYear != null
          ? { latestYear: input.pub.tagged.latestYear }
          : {}),
        ...(input.pub.tagged.pubs && input.pub.tagged.pubs.length > 0
          ? { pubs: input.pub.tagged.pubs }
          : {}),
        count: input.pub.tagged.count,
      }
    : undefined;
  // 1⇄2 — THE ONE ORDERING EXCEPTION: a method lead that the tagged lead
  // OUTNUMBERS gives up the primary slot to it.
  //
  // Method was unconditionally first, which buried the stronger signal whenever a
  // scholar's method footprint was the smaller of the two. Measured in prod on
  // `rgcryst`: the card led with "11 … AAV (method)" while "140 … Genetic Therapy
  // (tagged concept)" — the same scholar, 12.7× the publications — was folded into
  // "Also matched". The primary slot is the one thing on the card a searcher reads,
  // so ordering it by fiat rather than by magnitude is the card stating the weaker
  // case for its own result.
  //
  // A TWO-WAY COMPARISON, NOT A SORT, and deliberately so. The `tier === "lesser"`
  // block in `components/search/result-evidence.tsx` argues at length that these
  // counts come from DIFFERENT pipelines ("two pipelines, one frame") and that
  // framing them against a shared denominator manufactures a comparison — which is
  // why the lesser rows print magnitudes and no shares. That argument still stands
  // for `topic`: `areaCounts` is doc-precomputed and NOT query-filtered, so its N is
  // the scholar's total in that area whatever you searched, and it stays in slot 3
  // untouched. These two are the pair that IS comparable: both are distinct-
  // PUBLICATION counts over the SAME scholar, and `countOf` in `lib/api/search.ts`
  // clamps both to that scholar's `pubCount`, so "which of these two matched more of
  // this person's papers" is a question the data can answer.
  //
  // Both counts must be PRESENT. A not-yet-reindexed doc carries no
  // `methodFamilyCounts` map ⇒ no `method.count` ⇒ nothing to compare, and inferring
  // an order from an absent number is exactly the fabrication this change exists to
  // remove. Missing either side ⇒ today's method-first order, unchanged.
  // A TIE GOES TO THE TAGGED CONCEPT (`<=`, not `<`). Measured on staging: Szilard Kiss
  // matched `gene therapy` with method 3 and tagged 3, so a strict `<` left the method
  // line leading — advertising 3 AAV-vector papers as the reason, while the concept the
  // user actually typed sat in "Also matched" at the same magnitude. When the two counts
  // say the same thing, the tiebreak should go to the line whose denominator means the
  // same on every card (`pubCount`) and whose subject IS the query's descriptor; a method
  // family is a research-reagent detail underneath it.
  const methodCount = input.method?.count;
  const taggedCount = input.pub?.tagged?.count;
  const taggedAtLeastMethod =
    methodCount != null && taggedCount != null && methodCount <= taggedCount;
  if (methodLine && taggedLine && taggedAtLeastMethod) {
    lines.push(taggedLine, methodLine);
  } else {
    if (methodLine) lines.push(methodLine);
    if (taggedLine) lines.push(taggedLine);
  }
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
      ...(input.pub.mention.latestYear != null ? { latestYear: input.pub.mention.latestYear } : {}),
      ...(input.pub.mention.pubs && input.pub.mention.pubs.length > 0 ? { pubs: input.pub.mention.pubs } : {}),
      count: input.pub.mention.count,
    });
  // 5 — clinical: an INDEPENDENT line, appended whenever a clinical:exact match
  // exists, alongside the lines above. #1367 Gap 1 — now carries a display-only
  // on-topic pub count when the specialty has a curated MeSH anchor; still no
  // effect on ordering (this line is unconditionally appended either way).
  if (input.clinical)
    lines.push({
      kind: "clinical",
      specialty: input.clinical.specialty,
      boardCertified: input.clinical.boardCertified,
      ...(input.clinical.count != null ? { count: input.clinical.count } : {}),
      ...(input.clinical.eligiblePubCount != null
        ? { eligiblePubCount: input.clinical.eligiblePubCount }
        : {}),
    });
  // 6 — nothing first-class matched ⇒ the single-evidence tail (concept-text /
  // bio / affiliation / identity hints / honest-empty). It can't return
  // method/topic/tagged/mention/clinical here — all were handled + absent above.
  if (lines.length === 0) lines.push(selectEvidence(input));
  return lines;
}

/**
 * Does this evidence claim the person's RESEARCH matches the query, or does it merely say who and
 * where they are?
 *
 * The ladders above ALWAYS return something: `selectEvidence` terminates in `{ kind: "none" }`
 * and `selectEvidenceLines` falls back to it, so "no evidence" is not a thing either function
 * can express. That is correct for the People card, which renders the identity tail OUTSIDE its
 * match slot (see the `areas` doc: "E2 renders it OUTSIDE the match slot") and so never presents
 * it as a reason. It is NOT correct for any consumer that treats a returned evidence as "this is
 * why they matched" — such a consumer needs to know which side of the ladder it landed on, and
 * before this predicate existed it had no way to ask.
 *
 * #1696 — the sponsor console was that consumer. It fanned out one `searchPeople` per concept,
 * took `evidenceLines[0]`, and guarded with `if (!hitEvidence) continue` — a guard that CANNOT
 * fire against the real emitter. So an UNRESOLVED cluster (no MeSH descriptor ⇒ no tagged
 * reason) fell down the ladder to `areas`, and the card captioned the scholar's SELF-REPORTED
 * research areas with the sponsor's concept — rendering "who is this" as "why they matched".
 * That is a fabrication of relevance on a surface a fundraising officer acts on.
 *
 * ⚠ ASK THE RIGHT QUESTION. The obvious predicate — "was this derived from the query?" — is WRONG,
 * and it is wrong in a way that reads as correct. `affiliation` is query-derived (the mark landed in
 * the org segment of `preferredName`) and is still not evidence that this person WORKS on the
 * concept: it is the name of the group they sit in. Ship it and "Roel van Herten - AI In Medical
 * <mark>Imaging</mark>" appears captioned under the sponsor's "Diagnostic Imaging", asserting a
 * research match that nobody has claimed. It fires at rank 9 — i.e. precisely when NOTHING about
 * their work matched — so the person least connected to the concept is the one who gets the block.
 *
 * The question is therefore: **does this assert that their RESEARCH matches the query, as opposed to
 * who or where they are?**
 *
 * TRUE — a claim about the person's work:
 *   `method`          — the method family the query resolved to
 *   `topic`           — the research area the query matched
 *   `publications`    — a tagged/concept/mention count against the query's concept
 *   `clinical`        — a specialty the query literally names
 *   `selfDescription` — a sentence from their own bio containing the query. The weakest one allowed,
 *                       and self-reported — but it is a statement about their research, which is the
 *                       line being drawn. The emitter ranks it 8b, above affiliation, for the same reason.
 *
 * FALSE — identity, position, or the empty tail. None of these says anything about their work:
 *   `affiliation` — the ORG segment of the name highlight. The emitter's own comment: "9 —
 *                   affiliation (weak/organizational, just above empty)". Query-derived, not work.
 *   `name`        — the query hit their NAME. A researcher surnamed Parkinson is not thereby an
 *                   expert on Parkinson disease; that is the false-positive class the sponsor gold
 *                   grades 0. (Unreachable today — `selectEvidence` rank 1 deliberately never emits
 *                   it, #1267 — but the union permits it, so the answer must be recorded here.)
 *   `areas`       — self-reported research areas; the card's own doc calls this a who-is-this hint
 *                   and renders it OUTSIDE the match slot
 *   `concepts`    — top MeSH descriptors by pub frequency; same hint, denser source
 *   `none`        — the honest empty
 *   `fundingRole`, `awardAmount` — Phase-2 stubs. No People selector emits them AND
 *                   `components/search/result-evidence.tsx` renders them as `null`, so a caption
 *                   over one would be a labelled void — a concept asserted with visibly nothing
 *                   under it. If a selector ever emits them, decide then, with a renderer that draws.
 *
 * EXHAUSTIVE SWITCH, and deliberately NO `default`. A new `ResultEvidence` kind must fail to
 * compile here until someone decides which side it is on. That is the entire point: this bug
 * existed because a fallback was silently permissive, and a permissive default would recreate it
 * the next time the union grows.
 */
export function isResearchMatchEvidence(evidence: ResultEvidence): boolean {
  switch (evidence.kind) {
    case "method":
    case "clinical":
    case "topic":
    case "publications":
    case "selfDescription":
      return true;
    case "name":
    case "affiliation":
    case "areas":
    case "concepts":
    case "none":
    case "fundingRole":
    case "awardAmount":
      return false;
  }
}

/**
 * The ONE sanctioned way to read a publication magnitude off a hit's evidence.
 *
 * Contract rule O9 — a magnitude assembled by `kind` is not a magnitude. `kind` is
 * `"publications"` for all three of `tagged` (the scholar's papers carry the query's MeSH
 * DESCRIPTOR), `concept` (the MeSH-expansion TEXT variant) and `mention` (a paper title or
 * abstract happens to contain the literal string). Only the first is a subject claim. Pick the
 * line by `kind` and the column you build silently averages a curated tag with a word that
 * appeared in a sentence — six free-text mentions of a phrase then outrank two genuinely tagged
 * papers, and the scholar who actually works on the concept sorts last. That is the same
 * "two pipelines, one frame" error the `tier === "lesser"` block in
 * `components/search/result-evidence.tsx` refuses to make, and the reason the one comparison
 * this module DOES perform (`taggedAtLeastMethod`, above) is a targeted two-way test between
 * two counts that were established to be commensurable, never a sort over a mixed column.
 *
 * So: filter on `strength`, NEVER on `kind`. This function is that filter, and any consumer
 * that wants "how many of this person's papers back the query" should call it rather than
 * reach into the union itself.
 *
 * ABSENT ⇒ UNKNOWN, and the return type says so. `strength: "concept"` carries no `count` AT
 * ALL — see its construction at rank 5 of {@link selectEvidence}, which emits `text`/`term`/
 * `descendantTerms` and no numeric field — so a concept-led hit has no magnitude to give. The
 * honest answer is `undefined`; `0` is a DIFFERENT claim ("we looked and found none") and,
 * being orderable, it sinks the unmeasured scholar below every measured one. Never `?? 0` the
 * result of this function: branch on the absence, or leave the number unrendered the way
 * `evidenceMatchCount` (`lib/api/matcha-contract.ts`) and the `primaryCount` cell in
 * `result-evidence.tsx` already do.
 *
 * Takes the LIST because that is the shape a consumer holds (`PeopleSearchHit.evidenceLines`);
 * for the single-evidence path pass `[hit.evidence]`.
 */
export function taggedPubCount(lines: readonly ResultEvidence[]): number | undefined {
  for (const ev of lines) {
    if (ev.kind !== "publications" || ev.strength !== "tagged") continue;
    if (typeof ev.count === "number") return ev.count;
  }
  return undefined;
}
