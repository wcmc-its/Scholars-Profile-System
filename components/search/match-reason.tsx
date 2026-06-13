import type { ReactNode } from "react";
import { FileText, Sparkles, Tag } from "lucide-react";

/**
 * PLAN R4 — the kind of match a reason line explains, which picks the leading
 * icon (mockup mapping: document = publication-count evidence, tag = research
 * area, sparkle = concept expansion).
 */
export type MatchReasonKind = "concept" | "publications" | "area";

const ICONS: Record<MatchReasonKind, typeof Sparkles> = {
  concept: Sparkles,
  publications: FileText,
  area: Tag,
};

/**
 * PLAN R4 — one quiet "why this match" reason line, shared by the Publications,
 * Scholars, and Funding rows. Muted, single line, small leading icon by kind.
 * Replaces the #688/#702/#707 "Why this match" / "Matched in publications" /
 * "Matched on" surfaces. Shown only when the match isn't self-evident from the
 * row's own visible content (e.g. a highlighted title), never identical on
 * every row — the caller decides whether and what to render.
 */
export function MatchReason({
  kind,
  children,
  className = "",
}: {
  kind: MatchReasonKind;
  children: ReactNode;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <div
      className={`mt-2 flex min-w-0 items-center gap-1.5 text-[12.5px] leading-snug text-muted-foreground ${className}`}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
      {/* Single line — clips an over-long reason (e.g. #967's representative-pub
          title) rather than wrapping. A no-op for the short count/concept
          reasons, which already fit. */}
      <span className="truncate">{children}</span>
    </div>
  );
}
