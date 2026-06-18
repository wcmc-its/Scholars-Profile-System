/**
 * COI publications-review (#1112) shared mention helpers — PURE, framework-free,
 * and unit-testable, reused by the client projection (`lib/api/edit-context.ts`)
 * and the redesigned review UI so both views derive from ONE mention set.
 *
 * GOVERNANCE (do not regress): these helpers are "suggest, never accuse". They
 * carry only the qualitative tier ("High" | "Medium"), never the numeric score or
 * the internal `attribution` level. The forbidden vocabulary (undisclosed, failed
 * to disclose, missing, violation, gap, audit, compliance) appears NOWHERE in the
 * labels this module emits. Subject attribution is honest: an unresolved subject
 * is "unknown", NEVER guessed "self".
 *
 * The atomic unit is the MENTION (one paper × one matched organization). The
 * DECISION UNIT is `(pmid, subjectId)` — one author's relationships in one paper —
 * because that is the only coherent thing to judge. `subjectId` is the stable
 * grouping key; resolving a `(pmid, subjectId)` fans the feedback out to every
 * candidate row whose mention shares it (all orgs that subject names in that
 * paper).
 */

import type { SubjectType } from "./pipeline";

/** Re-export so consumers can take the canonical union from one place. */
export type { SubjectType } from "./pipeline";

/**
 * Normalize a subject token to a stable, comparison-safe form for the `subjectId`
 * key: lowercased, punctuation/diacritics folded, collapsed whitespace. Pure and
 * deterministic so the same printed token ("Dr Altorki", "Dr. Altorki,") always
 * collapses to the same id across reloads and across the two views.
 */
export function normalizeSubject(mention: string | null | undefined): string {
  return String(mention ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The stable DECISION-UNIT key for a mention: `(pmid, subjectId)`.
 *
 *   - `self`     → `"self"` (every self-mention in a paper is one decision unit);
 *   - `coauthor` → `"coauthor:" + normalizeSubject(subjectMention)` (each distinct
 *                  named co-author is its own unit; a null/blank token degrades to
 *                  the index form so it never silently merges with another);
 *   - `unknown`  → `"unknown:" + idx` (a STABLE per-paper index — two unresolved
 *                  subjects in one paper stay separate; never merged into "self").
 *
 * `idx` is the caller-supplied stable index of this mention within its paper
 * (used only for the `unknown` and tokenless-`coauthor` cases). It MUST be derived
 * deterministically (e.g. row order by candidate id) so the key is reproducible.
 */
export function subjectId(
  subjectType: SubjectType,
  subjectMention: string | null | undefined,
  idx: number,
): string {
  if (subjectType === "self") return "self";
  if (subjectType === "coauthor") {
    const norm = normalizeSubject(subjectMention);
    return norm ? `coauthor:${norm}` : `coauthor:#${idx}`;
  }
  return `unknown:#${idx}`;
}

/** Human labels for the relationship kinds parsed off a clause (spec §5/§7). The
 *  UI joins these for the summary line and per-row kind chips. Unknown/unmapped
 *  kinds pass through verbatim (defensive — the union is fixed but the DB column
 *  the value rides on is free text). */
const RELATIONSHIP_KIND_LABELS: Record<string, string> = {
  advisory_board: "advisory",
  consulting: "consulting",
  honoraria: "honoraria",
  grant: "grants",
  speaker_fees: "speaker fees",
  royalties: "royalties",
  ownership: "ownership",
  dsmb: "data safety monitoring",
  steering_committee: "steering committee",
  lecture_fees: "lecture fees",
  other: "other",
};

/** Humanize a single relationship-kind token ("advisory_board" → "advisory"). */
export function humanizeRelationshipKind(kind: string): string {
  return RELATIONSHIP_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/** Humanize + dedupe a list of relationship kinds, preserving input order. */
export function humanizeRelationshipKinds(kinds: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const k of kinds) {
    const label = humanizeRelationshipKind(k);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

// ----------------------------- highlighting (spec §4) -----------------------------

/**
 * A span to mark inside a rendered clause / statement. Spec §4: mark EXACTLY the
 * matched organization(s) and the SINGLE subject — never any other name or text.
 */
export interface HighlightSpan {
  /** Inclusive start offset into the source string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** What the span is, so the renderer picks the right treatment + aria-label. */
  role: "organization" | "subject";
  /** The exact substring covered (convenience for the renderer / tests). */
  text: string;
}

/** Case-insensitive, whole-WORD occurrences of `needle` in `haystack`, returned as
 *  [start, end) ranges. Empty/blank needle → no ranges. A hit is rejected when the
 *  needle's alphanumeric edge abuts another alphanumeric char, so a short token
 *  (initials like "SR", or a short org raw) never marks a substring inside an
 *  unrelated word (e.g. "SR" inside "MRISR") — spec §4 marks EXACTLY the org + the
 *  single subject, never generic text. Overlapping matches advance by one so a valid
 *  later hit isn't skipped. Pure string scan — no regex injection risk. */
function findOccurrences(haystack: string, needle: string | null | undefined): Array<[number, number]> {
  const n = String(needle ?? "").trim();
  if (!n) return [];
  const isWord = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  const guardStart = isWord(n[0]); // only enforce a boundary on an alphanumeric edge
  const guardEnd = isWord(n[n.length - 1]);
  const ranges: Array<[number, number]> = [];
  const hayLc = haystack.toLowerCase();
  const needleLc = n.toLowerCase();
  let from = 0;
  for (;;) {
    const i = hayLc.indexOf(needleLc, from);
    if (i === -1) break;
    const end = i + n.length;
    const before = i > 0 ? hayLc[i - 1] : undefined;
    const after = hayLc[end]; // undefined past the end
    if ((!guardStart || !isWord(before)) && (!guardEnd || !isWord(after))) {
      ranges.push([i, end]);
      from = end;
    } else {
      from = i + 1; // rejected substring hit — keep scanning for a real word match
    }
  }
  return ranges;
}

/**
 * Compute the spans to mark in a rendered clause/statement (spec §4): EXACTLY the
 * matched organization(s) + the SINGLE subject token, nothing else. Returns the
 * spans sorted by start, with overlaps resolved in favor of the FIRST-added role
 * (organization spans are added first, so a subject token nested inside an org
 * name never double-marks). The renderer walks these to wrap `<mark>`-style nodes;
 * everything between spans renders as plain text.
 *
 * `subjectMention` is `null` for `unknown` subjects — the spec marks nothing
 * inline there (the "Subject unclear" tag is a row/card-level affordance), so this
 * returns org-only spans in that case.
 */
export function computeHighlightSpans(
  text: string,
  organizationRaws: ReadonlyArray<string>,
  subjectMention: string | null,
): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const occupied: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => occupied.some(([os, oe]) => s < oe && os < e);
  const add = (role: HighlightSpan["role"], ranges: Array<[number, number]>) => {
    for (const [s, e] of ranges) {
      if (overlaps(s, e)) continue;
      occupied.push([s, e]);
      spans.push({ start: s, end: e, role, text: text.slice(s, e) });
    }
  };
  // Organizations first (the always-on amber chip), de-duped across the raw forms.
  const seen = new Set<string>();
  for (const org of organizationRaws) {
    const key = String(org ?? "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    add("organization", findOccurrences(text, org));
  }
  // Then the single subject (only when resolvable — unknown marks nothing inline).
  add("subject", findOccurrences(text, subjectMention));
  spans.sort((a, b) => a.start - b.start);
  return spans;
}
