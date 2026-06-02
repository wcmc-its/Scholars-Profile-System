/**
 * Issue #702 — pure classifier for which explainability element the People
 * result card surfaces for a hit. The source of truth for the precedence is
 * `components/search/people-result-card.tsx`:
 *
 *   self snippet  →  "Matched in publications" snippet  →  "Why this match"
 *   MeSH note  →  "Matched on" chip
 *
 * On the card the MeSH note renders *independently* of a snippet, but for
 * blank-card accounting we only care whether ANY element shows. `nonBlank` is
 * that OR; `primary` is the top-precedence element (for composition reporting).
 *
 * Kept in sync with the card by `tests/unit/match-explain-classify.test.ts`.
 * Used by `scripts/people-match-explain-dryrun.ts` to measure the coverage gate
 * (#307 pattern) before defaulting `SEARCH_PEOPLE_MATCH_EXPLAIN` on.
 */
import type { PeopleHit } from "@/lib/api/search";

export type ExplainKind = "self" | "pub" | "note" | "chip" | "blank";

export type ExplainClassification = {
  primary: ExplainKind;
  showsSelf: boolean;
  showsPub: boolean;
  showsNote: boolean;
  showsChip: boolean;
  /** At least one explainability element renders — i.e. the card is not bare. */
  nonBlank: boolean;
};

export function classifyHitExplain(
  hit: Pick<PeopleHit, "highlight" | "pubHighlight" | "matchProvenance" | "matchedOnFields">,
): ExplainClassification {
  const showsSelf = (hit.highlight?.length ?? 0) > 0;
  const showsPub = !showsSelf && (hit.pubHighlight?.length ?? 0) > 0;
  const showsNote = hit.matchProvenance != null;
  const showsChip =
    !showsSelf && !showsPub && !showsNote && (hit.matchedOnFields?.length ?? 0) > 0;
  const nonBlank = showsSelf || showsPub || showsNote || showsChip;
  const primary: ExplainKind = showsSelf
    ? "self"
    : showsPub
      ? "pub"
      : showsNote
        ? "note"
        : showsChip
          ? "chip"
          : "blank";
  return { primary, showsSelf, showsPub, showsNote, showsChip, nonBlank };
}
