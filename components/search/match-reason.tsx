import type { ReactNode } from "react";
import { FileText, FlaskConical, Sparkles, Tag } from "lucide-react";

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

/**
 * #824 follow-up — the match-aware "why" line in the approved mockup
 * (`docs/mockups/search-snippet/match-aware-snippet.html`). A small uppercase
 * badge (rust for method, blue for topic) with a leading lucide icon, then the
 * matched label in bold; the method variant trails up to 3 exemplar tool names,
 * muted and " · "-separated. Lives inside the result-card `<Link>`, so it is a
 * row of `<span>`s only (no nested interactive element); the icon is decorative
 * (`aria-hidden`). Colors are inlined from the mockup CSS variables.
 */
export function MatchAwareReason({
  kind,
  label,
  tools = [],
}: {
  kind: "method" | "topic";
  label: string;
  tools?: string[];
}) {
  // From the mockup: method bg #fbf4ea / border #ecdcc8 / ink #8a4a1f;
  // topic bg #eef2f6 / border #d8e2ec / ink #2c4f6e.
  const badge =
    kind === "method"
      ? "border-[#ecdcc8] bg-[#fbf4ea] text-[#8a4a1f]"
      : "border-[#d8e2ec] bg-[#eef2f6] text-[#2c4f6e]";
  const Icon = kind === "method" ? FlaskConical : Tag;
  const badgeText = kind === "method" ? "Method" : "Topic";
  return (
    <div className="mt-2 flex min-w-0 items-baseline gap-2 text-[13px] leading-snug">
      <span
        className={`inline-flex shrink-0 -translate-y-px items-center gap-1 rounded-[5px] border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.02em] ${badge}`}
      >
        <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
        {badgeText}
      </span>
      <span className="min-w-0 truncate">
        <strong className="font-semibold text-[#1a1a1a]">{label}</strong>
        {kind === "method" && tools.length > 0 ? (
          <span className="font-normal text-muted-foreground">
            {tools.map((t, i) => (
              <span key={`${t}-${i}`}>
                <span aria-hidden className="px-1.5 text-[#c9c4ba]">
                  ·
                </span>
                {t}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
}
