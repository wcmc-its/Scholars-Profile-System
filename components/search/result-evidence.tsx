import type { ResultEvidence } from "@/lib/api/result-evidence";
import { MatchReason, MatchAwareReason } from "@/components/search/match-reason";
import { HighlightedSnippet } from "@/components/search/highlight-snippet";
import { ConceptChipRow } from "@/components/search/concept-chip-row";

/**
 * #824 follow-up Phase 1 — the ONE renderer for the coherent search-result
 * evidence model (`lib/api/result-evidence.ts`, handoff §4). Given the single
 * `ResultEvidence` the server selected, render exactly that — the card never
 * re-derives priority. Mirrors `docs/mockups/search-snippet/snippet-cases.html`.
 *
 * Areas use the E2 treatment (handoff §5#1, settled by the 2026-06-16
 * fall-through measurement = 6% blank ≪ 15% gate): the match slot shows an
 * honest-empty line and the self-reported areas render BELOW it as a separate,
 * clearly-labeled "Areas" hint that is NOT styled as a match reason — separating
 * "why this matched" from "who is this".
 */

// Mockup token: italic, very light — an honest "nothing matched" line, never a
// fabricated reason.
function EmptyMatchLine() {
  return (
    <div className="mt-2 text-[12px] italic leading-snug text-[#bdbdbd]">
      &mdash; no specific match for this query &mdash;
    </div>
  );
}

// Mockup `.identity`: a labeled, boxed "who is this" hint, bounded to the
// server-capped labels with a "+N more" tail. The middot carries real spacing
// (handoff §3b — `· label`, not `·label`).
function AreasHint({ labels, total }: { labels: string[]; total: number }) {
  const more = total - labels.length;
  return (
    <div className="mt-2 flex min-w-0 items-baseline gap-2 rounded-md border border-[#e3e2dd] bg-[#f7f6f3] px-2.5 py-1.5 text-[12px] text-muted-foreground">
      <span className="shrink-0 text-[9.5px] font-bold uppercase tracking-[0.06em] text-[#9a958a]">
        Areas
      </span>
      <span className="min-w-0 truncate text-[#4a4a4a]">
        {labels.map((label, i) => (
          <span key={`${label}-${i}`}>
            {i > 0 ? <span className="px-1.5 text-[#c9c4ba]">·</span> : null}
            {label}
          </span>
        ))}
        {more > 0 ? <span className="ml-1 font-semibold text-[#9a958a]">+{more} more</span> : null}
      </span>
    </div>
  );
}

export function ResultEvidence({
  evidence,
  canExpand = false,
  expanded = false,
  onToggle,
  panelId,
  hasQuery = true,
  slug,
  badged = false,
}: {
  evidence: ResultEvidence;
  /** Rep-papers disclosure — when true and the evidence is a method/topic/
   *  publications match, the reason row shows a clickable chevron `<button>`
   *  controlling the representative-papers panel `panelId`. The card owns the
   *  state + the lazy fetch (method/topic) or the inline pubs (publications). */
  canExpand?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  panelId?: string;
  /** §4.7 — badge the publications reason row (Research area / Concept / Keyword
   *  flavor pill). Scoped to the Scholars card: only this renderer threads it, and
   *  the other surfaces call `<MatchReason>` directly, so they stay un-badged. */
  badged?: boolean;
  /** True when there is an active query. The honest-empty match line ("— no
   *  specific match for this query —") only makes sense when something was being
   *  matched; on the no-query Browse page it is suppressed for the identity
   *  kinds (areas/concepts/none), which carry no match snippet to hide. */
  hasQuery?: boolean;
  /** Scholar slug — used to build the `concepts` chip deep-links
   *  (`/{slug}?mesh=<ui>#publications`). Required wherever a concepts evidence
   *  can render (the People card always passes it). */
  slug?: string;
}) {
  switch (evidence.kind) {
    case "method":
      return (
        <MatchAwareReason
          kind="method"
          label={evidence.family}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        />
      );
    case "topic":
      return (
        <MatchAwareReason
          kind="topic"
          label={evidence.label}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        />
      );
    case "clinical":
      return (
        <MatchAwareReason
          kind="clinical"
          label={
            evidence.boardCertified
              ? `Board certified in ${evidence.specialty}`
              : `Clinical specialty: ${evidence.specialty}`
          }
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
        />
      );
    case "publications":
      // The count line IS the evidence; the representative papers ride the
      // disclosure (canExpand = pubs present). Concept is the sparkle variant
      // (Case F, folded in) and carries no pubs. §4.5 flavor: a MeSH-descriptor
      // hit IS a concept, so both `tagged` (exact descriptor) and `concept`
      // (expanded MeSH) render the "Concept" pill; `mention` (literal) → Keyword.
      // "Research area" is reserved for the actual topic-taxonomy match (the
      // `topic` MatchAwareReason), NOT a MeSH tag — those pubs aren't "tagged".
      return (
        <MatchReason
          kind={evidence.strength === "concept" ? "concept" : "publications"}
          canExpand={canExpand}
          expanded={expanded}
          onToggle={onToggle}
          panelId={panelId}
          badged={badged}
          flavor={evidence.strength === "mention" ? "keyword" : "concept"}
        >
          {evidence.text}
          {evidence.term ? (
            <>
              {" "}
              {/* #1361 — the matched term is always semibold; the dotted underline is
                  added ONLY for a system-expanded concept (tagged/concept), not for a
                  literal `mention` term. */}
              <span
                className={
                  evidence.strength === "mention"
                    ? "font-semibold"
                    : "font-semibold underline decoration-[rgba(52,64,138,0.55)] decoration-dotted decoration-1 underline-offset-[3px]"
                }
              >
                {evidence.term}
              </span>
              {/* #1355 — the narrower descendant term(s) the scholar actually carries. */}
              {evidence.descendantTerms && evidence.descendantTerms.length > 0 ? (
                <span className="text-[#6b7280]">
                  {" "}
                  (matched {evidence.descendantTerms.slice(0, 2).join(", ")}
                  {evidence.descendantTerms.length > 2
                    ? `, +${evidence.descendantTerms.length - 2} more`
                    : ""}
                  )
                </span>
              ) : null}
            </>
          ) : null}
        </MatchReason>
      );
    case "name":
      // Strongest signal — render the matched name fragment, term bold.
      return (
        <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "selfDescription":
      return (
        <div className="mt-2 text-[13px] leading-snug text-[#4a4a4a]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "affiliation":
      // Weak/organizational (handoff Edge G) — lighter than a real reason.
      return (
        <div className="mt-2 text-[12.5px] leading-snug text-[#777]">
          <HighlightedSnippet html={evidence.html} />
        </div>
      );
    case "concepts":
      // SEARCH_PEOPLE_CONCEPT_HINT — the top-MeSH identity hint, a single-line
      // fit-to-width row of deep-linking chips behind a tag glyph. Same E2
      // treatment as areas: an honest-empty match line ABOVE the row when there
      // is a query, the row alone on the no-query Browse page.
      return (
        <>
          {hasQuery ? <EmptyMatchLine /> : null}
          <ConceptChipRow items={evidence.items} slug={slug ?? ""} />
        </>
      );
    case "areas":
      // E2 — honest-empty match line + the separate "Areas" identity hint.
      return (
        <>
          {hasQuery ? <EmptyMatchLine /> : null}
          <AreasHint labels={evidence.labels} total={evidence.total} />
        </>
      );
    case "none":
      return hasQuery ? <EmptyMatchLine /> : null;
    default:
      // Phase-2 stub kinds (fundingRole / awardAmount) are not produced on the
      // People tab yet; render nothing rather than guess a treatment.
      return null;
  }
}
