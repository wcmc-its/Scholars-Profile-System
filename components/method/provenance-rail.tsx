import type { ReactNode } from "react";
import { highlightSnippet } from "./highlight-snippet";

/** One provenance entry the rail can display. Maps 1:1 to the spec §7 fields. */
export type ProvenanceRailItem = {
  /** Framing eyebrow — the only per-surface difference. Surface A:
   *  "Verbatim, from this scholar's papers"; Surface B: "Verbatim, from a paper
   *  using it". Soften to "Where it appears" when centrality is low (spec §4.2-A7,
   *  once #1166 emits `centrality_score`). */
  eyebrow: string;
  /** The tool / entity the sentence evidences (shown above the sentence, and the
   *  term highlighted within it). */
  term: string;
  /** The verbatim usage sentence (`usage_sentence`). */
  sentence: string;
  /** §7 `matched_span` char offsets, once #1166 emits them; null falls back to
   *  matching `term` within `sentence` (the #1119 interim — see highlightSnippet). */
  matchedSpan?: { start: number; end: number } | null;
  /** Source-publication click-through (`source_publication_id`); null when no
   *  source pmid is carried (e.g. a pre-#1158 row). */
  source?: { href: string; label?: string } | null;
};

/**
 * Shared provenance rail (spec §4.2-A6 / §5.3) — a persistent, light panel that
 * shows the verbatim sentence behind an inferred method/entity, with the matched
 * term highlighted and a link to its source publication. Surface A (#1167, the
 * scholar-profile "Methods & tools" panel) and Surface B (#1168, the method-detail
 * page) both render it; only the eyebrow copy differs per surface.
 *
 * Presentational by design: the CONSUMER owns hover/focus state and passes the
 * current `item` (or null before any interaction). Per spec §4.2-A1 the consumer
 * should retain the last-hovered item rather than clearing on mouse-leave ("never
 * blanks"); this component simply renders whatever it is given. The region is
 * `aria-live="polite"` so the sentence is announced on update, not just on hover
 * (spec §9). It never overlays content (spec §3.3 "never occlude") — the consumer
 * places it beside the list.
 */
export function ProvenanceRail({
  item,
  placeholder,
  action,
  className,
}: {
  item: ProvenanceRailItem | null;
  /** Shown when `item` is null (before any hover). Defaults to a quiet hint. */
  placeholder?: ReactNode;
  /** Optional trailing control — e.g. Surface A's "View N publications" pill. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-live="polite"
      className={"rounded-lg border bg-muted/30 p-4 text-sm" + (className ? ` ${className}` : "")}
    >
      {item ? (
        <>
          <p className="text-muted-foreground mb-1 text-[10px] font-medium tracking-wide uppercase">
            {item.eyebrow}
          </p>
          <p className="text-foreground mb-1 font-medium break-words">{item.term}</p>
          <p className="text-foreground/80 leading-snug">
            {highlightSnippet(item.sentence, item.term, item.matchedSpan)}
          </p>
          {item.source ? (
            <p className="mt-2">
              <a
                href={item.source.href}
                className="inline-flex items-center gap-0.5 text-xs text-[var(--color-accent-slate)] hover:underline"
              >
                {item.source.label ?? "Source publication"}
                <span aria-hidden="true"> →</span>
              </a>
            </p>
          ) : null}
          {action ? <div className="mt-3">{action}</div> : null}
        </>
      ) : (
        <p className="text-muted-foreground text-xs italic">
          {placeholder ?? "Hover a term to see the verbatim sentence it came from."}
        </p>
      )}
    </aside>
  );
}
